import {randomUUID} from "node:crypto";
import {PublicKey, SystemProgram} from "@solana/web3.js";
import type {Connection, Signer} from "@solana/web3.js";
import {BorshAccountsCoder} from "@coral-xyz/anchor";
import iqlabs from "@iqlabs-official/solana-sdk";

import {getWalletCtx} from "../../utils/wallet_manager";
import {sendInstruction} from "../../utils/tx";
import {logStep, logSuccess, logWarn} from "../../utils/logger";

const DEFAULT_ROOT_ID = "solchat-root";
const DM_TABLE_NAME = "dm";
const DM_COLUMNS = ["id", "text", "file", "sender", "timestamp"];
const DM_ID_COL = "id";

const makeMessageId = (sliceLength?: number) => {
    const uuid = typeof randomUUID === "function" ? randomUUID() : "";
    const id = uuid || Math.random().toString(36).slice(2, 10);
    return typeof sliceLength === "number" ? id.slice(0, sliceLength) : id;
};

export class ChatService {
    readonly connection: Connection;
    readonly signer: Signer;
    readonly dbRootId: Uint8Array;
    readonly programId: PublicKey;
    readonly builder: ReturnType<typeof iqlabs.contract.createInstructionBuilder>;
    readonly accountCoder: BorshAccountsCoder;

    constructor(rootId = DEFAULT_ROOT_ID) {
        const {connection, signer} = getWalletCtx();
        this.connection = connection;
        this.signer = signer;
        this.dbRootId = Buffer.from(rootId, "utf8");
        this.programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
        this.builder = iqlabs.contract.createInstructionBuilder();
        this.accountCoder = new BorshAccountsCoder(iqlabs.contract.IQ_IDL);
    }

    async setupCliDemo() {
        await this.ensureRootAndTables();
        await this.ensureUserState();
    }

    async ensureRootAndTables() {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const info = await this.connection.getAccountInfo(dbRoot);
        if (info) {
            return {dbRoot, created: false};
        }
        logStep("Database root not found. Creating on-chain root...");
        const ix = iqlabs.contract.initializeDbRootInstruction(
            this.builder,
            {
                db_root: dbRoot,
                signer: this.signer.publicKey,
                system_program: SystemProgram.programId,
            },
            {db_root_id: this.dbRootId},
        );
        const signature = await sendInstruction(this.connection, this.signer, ix);
        logSuccess("Database root created!");
        return {dbRoot, created: true, signature};
    }

    async ensureUserState(metadataTxId?: string) {
        const user = this.signer.publicKey;
        const userState = iqlabs.contract.getUserPda(user, this.programId);
        const codeAccount = iqlabs.contract.getCodeAccountPda(user, this.programId);
        const userInventory = iqlabs.contract.getUserInventoryPda(user, this.programId);
        const info = await this.connection.getAccountInfo(userInventory);
        if (!info) {
            logStep("User account not found on-chain. Initializing your account...");
            logWarn("This requires a small amount of SOL for the on-chain transaction fee.");
            const balance = await this.connection.getBalance(user);
            if (balance === 0) {
                throw new Error(
                    "Insufficient SOL balance — your wallet has 0 SOL.\n" +
                    `   Fund your wallet first: ${user.toBase58()}`
                );
            }
            const ix = iqlabs.contract.userInitializeInstruction(this.builder, {
                user,
                code_account: codeAccount,
                user_state: userState,
                user_inventory: userInventory,
                system_program: SystemProgram.programId,
            });
            await sendInstruction(this.connection, this.signer, ix);
            logSuccess("Account initialized successfully!");
        }
        if (metadataTxId) {
            await this.updateUserMetadata(metadataTxId);
        }
        return {userState, userInventory, codeAccount};
    }

    async updateUserMetadata(metadataTxId: string) {
        return iqlabs.writer.updateUserMetadata(
            this.connection,
            this.signer,
            this.dbRootId,
            metadataTxId,
        );
    }

    async requestConnection(partner: PublicKey) {
        const requester = this.signer.publicKey.toBase58();
        const receiver = partner.toBase58();
        const connectionSeed = iqlabs.utils.deriveDmSeed(requester, receiver);

        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const connectionTable = iqlabs.contract.getConnectionTablePda(
            dbRoot,
            connectionSeed,
            this.programId,
        );
        const info = await this.connection.getAccountInfo(connectionTable);
        if (info) {
            return {connectionSeed, connectionTable, created: false};
        }

        const signature = await iqlabs.writer.requestConnection(
            this.connection,
            this.signer,
            this.dbRootId,
            requester,
            receiver,
            DM_TABLE_NAME,
            DM_COLUMNS,
            DM_ID_COL,
            [],
        );
        return {connectionSeed, connectionTable, created: true, signature};
    }

    async manageConnection(connectionSeed: Uint8Array, newStatus: number) {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const connectionTable = iqlabs.contract.getConnectionTablePda(
            dbRoot,
            connectionSeed,
            this.programId,
        );
        const info = await this.connection.getAccountInfo(connectionTable);
        if (!info) {
            throw new Error("connection table not found");
        }
        const ix = iqlabs.contract.manageConnectionInstruction(
            this.builder,
            {
                db_root: dbRoot,
                connection_table: connectionTable,
                signer: this.signer.publicKey,
            },
            {
                db_root_id: this.dbRootId,
                connection_seed: Buffer.from(connectionSeed),
                new_status: newStatus,
            },
        );
        const signature = await sendInstruction(this.connection, this.signer, ix);
        return {signature, connectionTable};
    }

    async sendChat(roomSeed: Uint8Array, message: string, handle?: string) {
        const trimmed = message.trim();
        if (!trimmed) {
            throw new Error("message is empty");
        }
        const rowJson = JSON.stringify({
            id: makeMessageId(),
            text: trimmed,
            sender: handle?.trim() || this.signer.publicKey.toBase58(),
            timestamp: Date.now(),
        });
        return iqlabs.writer.writeRow(
            this.connection,
            this.signer,
            this.dbRootId,
            roomSeed,
            rowJson,
        );
    }

    async sendDm(dmSeed: Uint8Array, message: string, handle?: string) {
        const trimmed = message.trim();
        if (!trimmed) {
            throw new Error("message is empty");
        }
        const rowJson = JSON.stringify({
            id: makeMessageId(12),
            text: trimmed,
            sender: handle?.trim() || this.signer.publicKey.toBase58(),
            timestamp: Date.now(),
        });
        return iqlabs.writer.writeConnectionRow(
            this.connection,
            this.signer,
            this.dbRootId,
            dmSeed,
            rowJson,
        );
    }

    async fetchDmHistory(
        dmSeed: Uint8Array,
        options: { before?: string; limit?: number } = {},
    ) {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const connectionTable = iqlabs.contract.getConnectionTablePda(
            dbRoot,
            dmSeed,
            this.programId,
        );
        return iqlabs.reader.readTableRows(connectionTable, options);
    }

    async listFriends() {
        const owner = this.signer.publicKey;
        const ownerBase58 = owner.toBase58();
        const rootIdStr = Buffer.from(this.dbRootId).toString("utf8");
        const connections = await iqlabs.reader.fetchUserConnections(owner);

        return connections
            .filter((c) => c.dbRootId === rootIdStr)
            .map((c) => ({
                address: c.partyA === ownerBase58 ? c.partyB : c.partyA,
                status: c.status,
                statusCode:
                    c.status === "pending"
                        ? iqlabs.contract.CONNECTION_STATUS_PENDING
                        : c.status === "approved"
                            ? iqlabs.contract.CONNECTION_STATUS_APPROVED
                            : c.status === "blocked"
                                ? iqlabs.contract.CONNECTION_STATUS_BLOCKED
                                : -1,
                requester: c.requester,
                blocker: c.blocker,
                seed: iqlabs.utils.deriveDmSeed(c.partyA, c.partyB),
                table: new PublicKey(c.connectionPda),
                partyA: c.partyA,
                partyB: c.partyB,
                lastTimestamp: c.timestamp ?? 0,
                dbRootId: c.dbRootId,
            }))
            .sort((a, b) => Number(b.lastTimestamp ?? 0) - Number(a.lastTimestamp ?? 0));
    }

    async listRooms() {
        const list = await iqlabs.reader.getTablelistFromRoot(
            this.connection,
            this.dbRootId,
        );
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const seedHexes = [
            ...new Set([...list.tableSeeds, ...list.globalTableSeeds]),
        ];
        const rooms = [] as any[];

        for (const seedHex of seedHexes) {
            const seed = Buffer.from(seedHex, "hex");
            const table = iqlabs.contract.getTablePda(dbRoot, seed, this.programId);
            const info = await this.connection.getAccountInfo(table);
            let name = seedHex;
            if (info) {
                try {
                    const decoded = this.accountCoder.decode("Table", info.data) as {
                        name: Uint8Array;
                    };
                    const decodedName = Buffer.from(decoded.name)
                        .toString("utf8")
                        .replace(/\0+$/, "")
                        .trim();
                    if (decodedName) {
                        name = decodedName;
                    }
                } catch {
                    // ignore decode failures
                }
            }
            rooms.push({
                name,
                seed,
                seedHex,
                table,
            });
        }

        return rooms;
    }

    async createRoom(name: string) {
        const trimmed = name.trim();
        if (!trimmed) {
            throw new Error("room name is empty");
        }
        await this.ensureRootAndTables();

        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const tableSeed = iqlabs.utils.toSeedBytes(trimmed);
        const table = iqlabs.contract.getTablePda(dbRoot, tableSeed, this.programId);
        const existing = await this.connection.getAccountInfo(table);
        if (existing) {
            return {created: false};
        }

        const signature = await iqlabs.writer.createTable(
            this.connection,
            this.signer,
            this.dbRootId,
            trimmed,
            trimmed,
            DM_COLUMNS,
            DM_ID_COL,
            [],
        );
        return {created: true, signature};
    }

    async subscribeToAccount(account: PublicKey, options: { limit?: number } = {}) {
        const limit =
            typeof options.limit === "number" && options.limit > 0 ? options.limit : 10;
        const seen = new Set<string>();
        const latest = await this.connection.getSignaturesForAddress(account, {limit});
        for (const sig of latest) {
            seen.add(sig.signature);
        }

        const subscriptionId = this.connection.onAccountChange(
            account,
            async () => {
                const signatures = await this.connection.getSignaturesForAddress(account, {limit});
                const fresh = signatures.filter((sig) => !seen.has(sig.signature));
                if (fresh.length === 0) {
                    return;
                }
                for (const sig of fresh.reverse()) {
                    seen.add(sig.signature);
                    let result: {data: string | null; metadata: string};
                    try {
                        result = await iqlabs.reader.readCodeIn(sig.signature);
                    } catch (err) {
                        if (
                            err instanceof Error &&
                            err.message.includes(
                                "user_inventory_code_in instruction not found",
                            )
                        ) {
                            continue;
                        }
                        throw err;
                    }
                    const {data, metadata} = result;
                    if (!data) {
                        console.log({
                            signature: sig.signature,
                            metadata,
                            data: null,
                        });
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                            console.log({...parsed, __txSignature: sig.signature});
                            continue;
                        }
                    } catch {
                        // fallthrough
                    }
                    console.log({signature: sig.signature, metadata, data});
                }
            },
            "confirmed",
        );

        return () => this.connection.removeAccountChangeListener(subscriptionId);
    }

    async joinRoom(roomSeed: Uint8Array, options: { limit?: number } = {}) {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const table = iqlabs.contract.getTablePda(dbRoot, roomSeed, this.programId);
        return this.subscribeToAccount(table, options);
    }

    async joinDm(dmSeed: Uint8Array, options: { limit?: number } = {}) {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const connectionTable = iqlabs.contract.getConnectionTablePda(
            dbRoot,
            dmSeed,
            this.programId,
        );
        return this.subscribeToAccount(connectionTable, options);
    }

    deriveRoomTable(roomSeed: Uint8Array) {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const table = iqlabs.contract.getTablePda(dbRoot, roomSeed, this.programId);
        const instructionTable = iqlabs.contract.getInstructionTablePda(
            dbRoot,
            roomSeed,
            this.programId,
        );
        return {table, instructionTable};
    }
}
