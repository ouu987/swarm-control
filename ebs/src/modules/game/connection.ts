import { Message, MessageType, TwitchUser } from "./messages";
import { ResultMessage, GameMessage } from "./messages.game";
import * as ServerWS from "ws";
import { v4 as uuid } from "uuid";
import { CommandInvocationSource, RedeemMessage, ServerMessage } from "./messages.server";
import { Cart, Redeem } from "common/types";
import { setIngame } from "../config";

const VERSION = "0.1.0";

type ResultHandler = (result: ResultMessage) => any;

export class GameConnection {
    private handshake: boolean = false;
    private socket: ServerWS | null = null;
    private unsentQueue: ServerMessage[] = [];
    private outstandingRedeems: Map<string, RedeemMessage> = new Map();
    private resultHandlers: Map<string, ResultHandler> = new Map();
    static resultWaitTimeout: number = 10000;
    private resendIntervalHandle?: number;
    private resendInterval = 500;

    public isConnected() {
        return this.socket?.readyState == ServerWS.OPEN;
    }
    public setSocket(ws: ServerWS | null) {
        if (this.isConnected()) {
            this.socket!.close();
        }
        this.socket = ws;
        if (!ws) {
            return;
        }
        console.log("Connected to game");
        this.handshake = false;
        this.resendIntervalHandle = +setInterval(() => this.tryResendFromQueue(), this.resendInterval);
        ws.on('message', async (message) => {
            const msgText = message.toString();
            let msg: GameMessage;
            try {
                msg = JSON.parse(msgText);
            } catch {
                console.error("Could not parse message" + msgText);
                return;
            }
            if (msg.messageType !== MessageType.Ping)
                console.log(`Got message ${JSON.stringify(msg)}`);
            this.processMessage(msg);
        });
        ws.on("close", (code, reason) => {
            const reasonStr = reason ? `reason '${reason}'` : "no reason"
            console.log(`Game socket closed with code ${code} and ${reasonStr}`);
            setIngame(false);
            if (this.resendIntervalHandle) {
                clearInterval(this.resendIntervalHandle);
            }
        })
        ws.on("error", (error) => {
            console.log(`Game socket error\n${error}`);
        })
    }
    public async processMessage(msg: GameMessage) {
        switch (msg.messageType) {
            case MessageType.Hello:
                this.handshake = true;
                const reply = {
                    ...this.makeMessage(MessageType.HelloBack),
                    allowed: msg.version == VERSION,
                }
                this.sendMessage(reply).then().catch(e => e);
                break;
            case MessageType.Ping:
                this.sendMessage(this.makeMessage(MessageType.Pong)).then().catch(e => e);
                break;
            case MessageType.Result:
                if (!this.outstandingRedeems.has(msg.guid)) {
                    console.error(`[${msg.guid}] Redeeming untracked ${msg.guid} (either unpaid or more than once)`);
                }
                const resolve = this.resultHandlers.get(msg.guid);
                if (!resolve) {
                    // nobody cares about this redeem :(
                    console.warn(`[${msg.guid}] No result handler for ${msg.guid}`);
                } else {
                    resolve(msg);
                }
                this.outstandingRedeems.delete(msg.guid);
                this.resultHandlers.delete(msg.guid);
                break;
            case MessageType.IngameStateChanged:
                setIngame(msg.ingame);
                break;
            default:
                this.logMessage(msg, `Unknown message type ${msg.messageType}`);
                break;
        }
    }

    public sendMessage(msg: ServerMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.isConnected()) {
                const error = `Tried to send message without a connected socket`;
                this.msgSendError(msg, error);
                reject(error);
                return;
            }
            // allow pong for stress test
            if (!this.handshake && msg.messageType !== MessageType.Pong) {
                const error = `Tried to send message before handshake was complete`;
                this.msgSendError(msg, error);
                reject(error);
                return;
            }
            this.socket!.send(JSON.stringify(msg), { binary: false, fin: true }, (err) => {
                if (err) {
                    this.msgSendError(msg, `${err.name}: ${err.message}`);
                    reject(err);
                    return;
                }
                if (msg.messageType !== MessageType.Pong)
                    console.debug(`Sent message ${JSON.stringify(msg)}`);
                resolve();
            });
        });
    }
    public makeMessage(type: MessageType, guid?: string): Message {
        return {
            messageType: type,
            guid: guid ?? uuid(),
            timestamp: Date.now()
        }
    }
    public redeem(redeem: Redeem, cart: Cart, user: TwitchUser, transactionId: string) : Promise<ResultMessage> {
        return Promise.race([
            new Promise<any>((_, reject) => setTimeout(() => reject(`Timed out waiting for result. The redeem may still go through later, contact Alexejhero if it doesn't.`), GameConnection.resultWaitTimeout)),
            new Promise<ResultMessage>((resolve, reject) => {
                if (!transactionId) {
                    reject(`Tried to redeem without transaction ID`);
                    return;
                }
    
                const msg: RedeemMessage = {
                    ...this.makeMessage(MessageType.Redeem),
                    guid: transactionId,
                    source: CommandInvocationSource.Swarm,
                    command: redeem.id,
                    title: redeem.title,
                    announce: redeem.announce ?? true,
                    args: cart.args,
                    user
                } as RedeemMessage;
                if (this.outstandingRedeems.has(msg.guid)) {
                    reject(`Redeeming ${msg.guid} more than once`);
                    return;
                }
                this.outstandingRedeems.set(msg.guid, msg);
                this.resultHandlers.set(msg.guid, resolve);
    
                this.sendMessage(msg).then().catch(e => e); // will get queued to re-send later
            })
        ]);
    }

    private logMessage(msg: Message, message: string) {
        console.log(`[${msg.guid}] ${message}`);
    }

    private msgSendError(msg: ServerMessage, error: any) {
        this.unsentQueue.push(msg);
        console.error(`Error sending message\n\tMessage: ${JSON.stringify(msg)}\n\tError: ${error}`);
        console.log(`Position ${this.unsentQueue.length} in queue`);
    }

    private tryResendFromQueue() {
        const msg = this.unsentQueue.shift();
        if (msg === undefined) {
            //console.log("Nothing to re-send");
            return;
        }

        console.log(`Re-sending message ${JSON.stringify(msg)}`);
        this.sendMessage(msg).then().catch(e => e);
    }
    public stressTestSetHandshake(handshake: boolean) {
        this.handshake = handshake;
    }
}
