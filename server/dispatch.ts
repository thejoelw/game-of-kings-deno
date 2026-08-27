import * as t from 'io-ts';

import Connection from '~/server/Connection.ts';
import { makeDecoder } from '~/common/coder.ts';
import {
  MoveCodec,
  PacketCodec,
  SubMsgCodec,
  UnsubMsgCodec,
} from '~/common/codecs.ts';
import { getModuleInstance, ModuleInstance } from '~/server/modules.ts';
import { LobbyModule, MatchModule, UserModule } from '~/common/modules.ts';
import { tutorialUserId } from '~/common/tutorial.ts';
import { shuffleInPlace } from '~/common/utils.ts';
import { makeCells } from '~/common/cells.ts';
import { ABORT_TIMEOUT } from '~/common/constants.ts';
import { enumerateLegalMoves } from '~/common/moves.ts';

const packetDecoder = makeDecoder(PacketCodec);
const subDecoder = makeDecoder(SubMsgCodec);
const unsubDecoder = makeDecoder(UnsubMsgCodec);
const moveDecoder = makeDecoder(
  t.intersection([MoveCodec, t.type({ matchId: t.string })]),
);

const lobby = getModuleInstance('lobby', LobbyModule);

const matchTimeouts = new Map<string, number>();

export const dispatchJoin = (conn: Connection) => {
};
export const dispatchLeave = (conn: Connection) => {
  conn.modules.forEach((mod) => mod.leave(conn));
};

const getModuleDefn = (name: string): {
  initialState: unknown;
  reducers: Record<string, (state: any, action: any) => any>;
} => {
  const defn = {
    lobby: LobbyModule,
    user: UserModule,
    match: MatchModule,
  }[name.split('-', 1)[0]];
  if (defn === undefined) {
    throw new Error(`Cannot parse key ${name}!`);
  }
  return defn;
};

const preMove = (
  matchId: string,
  match: ModuleInstance<
    (typeof MatchModule)['initialState'],
    (typeof MatchModule)['reducers']
  >,
) => {
  const endMatch = () => {
    const { variant, players, status, winner } = match.getState();

    if (['drawn', 'checkmate', 'timeout'].includes(status)) {
      const users = players.map(({ userId }) =>
        getModuleInstance(`user-${userId}`, UserModule)
      );
      const ratings = users.map((u) => u.getState().rating);

      users[0].actors.matchResult({
        opponentRating: ratings[1],
        result: winner === undefined ? 0.5 : 1 - winner,
        stakes: variant.stakes,
      });

      users[1].actors.matchResult({
        opponentRating: ratings[0],
        result: winner === undefined ? 0.5 : winner,
        stakes: variant.stakes,
      });
    }

    if (variant.formation !== 'tutorial') {
      lobby.actors.endMatch({ matchId, status });
    }
  };

  const {
    players,
    playerToMove,
    log,
    moveStartDate,
    status,
  } = match.getState();

  if (status === 'playing') {
    if (log.length < 2) {
      const timeout = setTimeout(() => {
        matchTimeouts.delete(matchId);
        match.actors.abort({});
        endMatch();
      }, moveStartDate + ABORT_TIMEOUT - Date.now());

      matchTimeouts.set(matchId, timeout);
    } else {
      const timeout = setTimeout(() => {
        matchTimeouts.delete(matchId);
        match.actors.timeout({ winner: 1 - playerToMove });
        endMatch();
      }, moveStartDate + players[playerToMove].timeForMoveMs - Date.now());

      matchTimeouts.set(matchId, timeout);
    }
  } else {
    endMatch();
  }
};

const dispatchers: { [key: string]: (conn: Connection, arg: any) => void } = {
  ping(conn: Connection, arg: any) {
    if (typeof arg === 'string' && arg.length <= 256) {
      conn.sendText(JSON.stringify({ type: 'pong', arg }));
    }
  },

  sub(conn: Connection, arg: any) {
    const name = subDecoder(arg);
    const mod = getModuleInstance(name, getModuleDefn(name));
    mod.join(conn);
    conn.modules.add(mod);
  },

  unsub(conn: Connection, arg: any) {
    const name = unsubDecoder(arg);
    const mod = getModuleInstance(name, getModuleDefn(name));
    conn.modules.delete(mod);
    mod.leave(conn);
  },

  renameUser(conn: Connection, arg: any) {
    conn.getUserModule().actors.update({ username: arg });
  },
  extendChallenge(conn: Connection, arg: any) {
    lobby.actors.extendChallenge(arg);
  },
  retractChallenge(conn: Connection, arg: any) {
    lobby.actors.retractChallenge(arg);
  },
  acceptChallenge(conn: Connection, arg: any) {
    const challenge = lobby
      .getState()
      .challenges.find((c) => c.id === arg.challengeId);
    if (!challenge || challenge.matchId) {
      throw new Error(`Invalid challengeId: ${arg.challengeId}`);
    }

    const matchId = Math.random().toString(36).slice(2);

    const players = [challenge.challengerId, conn.getUserId()].map((
      userId,
    ) => ({
      userId,
      spawnsAvailable: challenge.variant.spawnsAvailable,
      timeForMoveMs: challenge.variant.timeInitialMs,
    }));

    const match = getModuleInstance(`match-${matchId}`, MatchModule);
    match.actors.reset({
      variant: challenge.variant,
      log: [],
      players: challenge.challengerId === tutorialUserId
        ? players
        : shuffleInPlace(players),
      playerToMove: 0,
      moveStartDate: Date.now(),
      cells: makeCells(challenge.variant),
      chat: [],
      status: 'playing',
      winner: undefined,
    });

    lobby.actors.acceptChallenge({
      ...arg,
      acceptDate: Date.now(),
      matchId,
    });

    preMove(matchId, match);
  },

  doMove(conn: Connection, arg: any) {
    arg = { ...arg, date: Date.now() };
    const { type, matchId } = moveDecoder(arg);

    const match = getModuleInstance(`match-${matchId}`, MatchModule);

    {
      const { players, playerToMove, status } = match.getState();

      if (status !== 'playing') {
        throw new Error(`You cannot move in an ${status} match`);
      }

      if (players[playerToMove].userId !== conn.getUserId()) {
        throw new Error(`You cannot move for that player`);
      }

      const candidateMoves = enumerateLegalMoves(match.getState());

      if (
        !candidateMoves.some((m) =>
          Object.entries(m).every(([k, v]) => arg[k] === v)
        )
      ) {
        throw new Error(`Invalid move: ${JSON.stringify(arg)}`);
      }
    }

    if (matchTimeouts.has(matchId)) {
      clearTimeout(matchTimeouts.get(matchId)!);
      matchTimeouts.delete(matchId);
    }

    match.actors.doMove(arg);

    preMove(matchId, match);
  },

  chat(conn: Connection, arg: any) {
    if (conn.getUserId() === tutorialUserId) {
      arg = { ...arg, date: Date.now(), userId: conn.getUserId() };

      const match = getModuleInstance(`match-${arg.matchId}`, MatchModule);

      match.actors.chat(arg);
    }
  },

  resetPartial(conn: Connection, arg: any) {
    if (conn.getUserId() === tutorialUserId) {
      const match = getModuleInstance(`match-${arg.matchId}`, MatchModule);

      match.actors.resetPartial(arg);
    }
  },
};

export const dispatch = (conn: Connection, msg: any) => {
  const { type, arg } = packetDecoder(msg);
  const func = dispatchers[type];
  if (func === undefined) {
    throw new Error(`No dispatcher for ${type}!`);
  }
  func(conn, arg);
};
