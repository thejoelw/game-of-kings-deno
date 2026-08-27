import { decodeIdentify, VerifierCtx } from '~/common/packet.ts';
import { bin2hex } from '~/common/hex.ts';

import { dispatch, dispatchJoin, dispatchLeave } from '~/server/dispatch.ts';
import { GenericModuleInstance, getModuleInstance } from '~/server/modules.ts';
import { UserModule } from '~/common/modules.ts';
import { hash } from '~/common/hash.ts';

export default class Connection {
  public uuid = Math.random().toString(36).slice(2);

  private ctx: VerifierCtx = {};
  private userId?: string;

  public modules = new Set<GenericModuleInstance>();

  constructor(public sendText: (str: string) => void) {
    // TODO: Send UUID as challenge for client to sign
    dispatchJoin(this);
  }

  public getUserId() {
    if (this.userId === undefined) {
      throw new Error(`Cannot get the user id of an unidentified connection!`);
    }
    return this.userId;
  }

  public getUserModule() {
    return getModuleInstance(`user-${this.getUserId()}`, UserModule);
  }

  public onBinary(buf: Uint8Array) {
    const publicKey = decodeIdentify(buf, this.ctx);
    this.userId = bin2hex(hash(publicKey));
  }

  public onText(str: string) {
    dispatch(this, JSON.parse(str));
  }

  public onClose() {
    dispatchLeave(this);
  }
}
