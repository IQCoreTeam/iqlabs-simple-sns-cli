import {randomUUID, createHash} from "node:crypto";
import {PublicKey, SystemProgram} from "@solana/web3.js";
import type {Connection, Signer} from "@solana/web3.js";
import {BorshAccountsCoder} from "@coral-xyz/anchor";
import {ed25519} from "@noble/curves/ed25519";
import iqlabs from "@iqlabs-official/solana-sdk";

import {getWalletCtx} from "../../utils/wallet_manager";
import {sendInstruction} from "../../utils/tx";
import {logStep, logSuccess, logWarn} from "../../utils/logger";

const DEFAULT_ROOT_ID = "solchat-root";
const DM_TABLE_NAME = "dm";
const DM_COLUMNS = ["id", "text", "file", "sender", "timestamp"];
const DM_ID_COL = "id";

// Anchor instruction discriminators = sha256("global:<name>")[0..8].
// These let us recognize connection-related instructions without relying on
// the SDK's instructionCoder (which currently fails to decode them).
const anchorDisc = (name: string) =>
    createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
const REQUEST_CONNECTION_DISC = anchorDisc("request_connection");
const MANAGE_CONNECTION_DISC = anchorDisc("manage_connection");
// In the request_connection / manage_connection instructions, the
// `connection_table` PDA is the 4th account (index 3 in accountKeyIndexes).
const CONNECTION_TABLE_IX_INDEX = 3;

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

    // Deterministic ed25519 signer from this wallet's secret key.
    // Used by deriveX25519Keypair to produce a DH keypair that is
    // reproducible for the same wallet.
    private signWithWallet = async (msg: Uint8Array): Promise<Uint8Array> => {
        const secret = (this.signer as any).secretKey as Uint8Array;
        if (!secret || secret.length < 32) {
            throw new Error("wallet does not expose a raw secret key for signing");
        }
        return ed25519.sign(msg, secret.slice(0, 32));
    };

    async deriveMyDhKeypair(): Promise<{ privKey: Uint8Array; pubKey: Uint8Array; pubHex: string }> {
        const crypto = (iqlabs as any).crypto;
        const {privKey, pubKey} = await crypto.deriveX25519Keypair(this.signWithWallet);
        return {privKey, pubKey, pubHex: crypto.bytesToHex(pubKey)};
    }

    async registerMyDhKey(): Promise<string> {
        const {pubHex} = await this.deriveMyDhKeypair();
        const payload = JSON.stringify({t: "iq-locker-key-v1", k: pubHex});
        return iqlabs.writer.codeIn(
            {connection: this.connection, signer: this.signer},
            payload,
            "locker-key.json",
            0,
            "application/json",
        );
    }

    // Idempotent: if our DH key is already on-chain, return it without
    // spending any SOL. Otherwise derive + register it once and cache.
    async ensureMyDhKey(): Promise<{ pubHex: string; created: boolean; signature?: string }> {
        const myAddress = this.signer.publicKey.toBase58();
        const cached = ChatService._dhKeyCache.get(myAddress);
        if (cached) return {pubHex: cached, created: false};

        const me = await this.deriveMyDhKeypair();
        const existing = await this.lookupDhKey(myAddress);
        if (existing === me.pubHex) {
            ChatService._dhKeyCache.set(myAddress, me.pubHex);
            return {pubHex: me.pubHex, created: false};
        }

        const signature = await this.registerMyDhKey();
        ChatService._dhKeyCache.set(myAddress, me.pubHex);
        return {pubHex: me.pubHex, created: true, signature};
    }

    // Module-level cache so repeat DM opens don't re-check the chain.
    private static _dhKeyCache = new Map<string, string>();

    // Scan a user's inventory code_in transactions to find their locker-key.json.
    // Returns the hex X25519 public key, or null if not registered.
    async lookupDhKey(walletAddress: string): Promise<string | null> {
        try {
            const pubkey = new PublicKey(walletAddress);
            const inventoryPda = iqlabs.contract.getUserInventoryPda(pubkey, this.programId);
            const signatures = await this.connection.getSignaturesForAddress(inventoryPda, {limit: 100});
            for (const sig of signatures) {
                try {
                    const result = await iqlabs.reader.readCodeIn(sig.signature);
                    if (!result?.data) continue;
                    const meta = typeof result.metadata === "string"
                        ? JSON.parse(result.metadata)
                        : result.metadata;
                    if (meta?.filename !== "locker-key.json") continue;
                    const parsed = JSON.parse(result.data);
                    if (parsed?.t === "iq-locker-key-v1" && typeof parsed.k === "string") {
                        return parsed.k;
                    }
                } catch {
                    continue;
                }
            }
        } catch {
            return null;
        }
        return null;
    }

    async sendEncryptedDm(
        dmSeed: Uint8Array,
        partnerAddress: string,
        message: string,
        handle?: string,
    ): Promise<{signature: string; partnerHasKey: boolean}> {
        const trimmed = message.trim();
        if (!trimmed) throw new Error("message is empty");

        const crypto = (iqlabs as any).crypto;
        const me = await this.deriveMyDhKeypair();
        const partnerPub = await this.lookupDhKey(partnerAddress);
        if (!partnerPub) {
            throw new Error(
                `Partner has not registered an IQ encryption key yet: ${partnerAddress}`,
            );
        }

        const plaintext = new TextEncoder().encode(trimmed);
        const encrypted = await crypto.multiEncrypt([me.pubHex, partnerPub], plaintext);

        // iq-locker style compact envelope
        const envelope = {
            m: "dm",
            r: encrypted.recipients.map((r: any) => [
                r.recipientPub, r.ephemeralPub, r.wrappedKey, r.wrapIv,
            ]),
            i: encrypted.iv,
            c: encrypted.ciphertext,
        };

        const rowJson = JSON.stringify({
            id: makeMessageId(12),
            text: JSON.stringify(envelope),
            sender: handle?.trim() || this.signer.publicKey.toBase58(),
            timestamp: Date.now(),
            enc: 1,
        });

        const signature = await iqlabs.writer.writeConnectionRow(
            this.connection,
            this.signer,
            this.dbRootId,
            dmSeed,
            rowJson,
        );
        return {signature, partnerHasKey: true};
    }

    // Try to decrypt a DM row's text. Returns { text, encrypted } — text is
    // plaintext if decryption succeeded, otherwise the raw envelope string.
    async tryDecryptDmRow(row: any): Promise<{ text: string; encrypted: boolean; decrypted: boolean }> {
        const raw = typeof row === "string" ? (() => { try { return JSON.parse(row); } catch { return {text: row}; } })() : row;
        const text = raw?.text ?? "";
        // Quick check: encrypted rows carry an envelope JSON in `text` starting with {"m":"dm"
        if (typeof text !== "string" || !text.startsWith('{"m":"dm"')) {
            return {text, encrypted: false, decrypted: false};
        }
        try {
            const env = JSON.parse(text);
            if (env.m !== "dm" || !Array.isArray(env.r)) {
                return {text, encrypted: false, decrypted: false};
            }
            const crypto = (iqlabs as any).crypto;
            const me = await this.deriveMyDhKeypair();
            const recipients = env.r.map((r: string[]) => ({
                recipientPub: r[0], ephemeralPub: r[1], wrappedKey: r[2], wrapIv: r[3],
            }));
            const plain = await crypto.multiDecrypt(me.privKey, me.pubHex, {
                recipients,
                iv: env.i,
                ciphertext: env.c,
            });
            return {text: new TextDecoder().decode(plain), encrypted: true, decrypted: true};
        } catch {
            return {text, encrypted: true, decrypted: false};
        }
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

    // Scan the user's UserState tx history, filter to request_connection /
    // manage_connection instructions, and pull the connection_table PDA
    // straight from each instruction's account list. Unlike
    // iqlabs.reader.fetchUserConnections (which relies on an SDK instruction
    // coder that currently mis-decodes these instructions and silently skips
    // incoming requests), this walks the raw compiled instructions by
    // discriminator, so it catches both incoming and outgoing connections.
    async listFriends() {
        const owner = this.signer.publicKey;
        const ownerBase58 = owner.toBase58();
        const rootIdStr = Buffer.from(this.dbRootId).toString("utf8");
        const userState = iqlabs.contract.getUserPda(owner, this.programId);

        const sigs = await this.connection.getSignaturesForAddress(userState, {
            limit: 200,
        });

        const connectionPdas = new Map<string, number>(); // pdaBase58 -> latest blockTime
        for (const sig of sigs) {
            let tx;
            try {
                tx = await this.connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                });
            } catch {
                continue;
            }
            if (!tx) continue;
            const keys = tx.transaction.message.getAccountKeys();
            for (const ix of tx.transaction.message.compiledInstructions) {
                const programKey = keys.get(ix.programIdIndex);
                if (!programKey || !programKey.equals(this.programId)) continue;
                const disc = Buffer.from(ix.data).slice(0, 8);
                if (!disc.equals(REQUEST_CONNECTION_DISC) && !disc.equals(MANAGE_CONNECTION_DISC)) {
                    continue;
                }
                const ctGlobalIdx = ix.accountKeyIndexes[CONNECTION_TABLE_IX_INDEX];
                if (ctGlobalIdx === undefined) continue;
                const ctKey = keys.get(ctGlobalIdx);
                if (!ctKey) continue;
                const ctStr = ctKey.toBase58();
                const ts = sig.blockTime ?? 0;
                const prev = connectionPdas.get(ctStr) ?? 0;
                if (ts > prev) connectionPdas.set(ctStr, ts);
            }
        }

        const results: any[] = [];
        for (const [pdaStr, lastTs] of connectionPdas) {
            let info;
            try {
                info = await this.connection.getAccountInfo(new PublicKey(pdaStr));
            } catch {
                continue;
            }
            if (!info) continue;
            let decoded: any;
            try {
                decoded = this.accountCoder.decode("Connection", info.data);
            } catch {
                continue;
            }
            const partyA = new PublicKey(decoded.party_a).toBase58();
            const partyB = new PublicKey(decoded.party_b).toBase58();
            if (partyA !== ownerBase58 && partyB !== ownerBase58) continue;

            const dbRootId = Buffer.from(decoded.db_root_id)
                .toString("utf8")
                .replace(/\0+$/, "");
            if (dbRootId !== rootIdStr) continue;

            const statusCode = Number(decoded.status);
            const status =
                statusCode === iqlabs.contract.CONNECTION_STATUS_PENDING
                    ? "pending"
                    : statusCode === iqlabs.contract.CONNECTION_STATUS_APPROVED
                        ? "approved"
                        : statusCode === iqlabs.contract.CONNECTION_STATUS_BLOCKED
                            ? "blocked"
                            : "unknown";
            const requesterRaw = Number(decoded.requester); // 0 = partyA, 1 = partyB
            const blockerRaw = Number(decoded.blocker);     // 0 / 1 / 255
            const requesterAddress = requesterRaw === 0 ? partyA : partyB;
            const blockerAddress =
                blockerRaw === 0 ? partyA : blockerRaw === 1 ? partyB : null;

            results.push({
                address: partyA === ownerBase58 ? partyB : partyA,
                status,
                statusCode,
                requester: requesterAddress,
                requesterRaw,
                blocker: blockerAddress,
                blockerRaw,
                seed: iqlabs.utils.deriveDmSeed(partyA, partyB),
                table: new PublicKey(pdaStr),
                partyA,
                partyB,
                lastTimestamp: lastTs,
                dbRootId,
            });
        }

        return results.sort(
            (a, b) => Number(b.lastTimestamp ?? 0) - Number(a.lastTimestamp ?? 0),
        );
    }

    async listRooms() {
        // NOTE: "hello worl.d" and "second room" exist on-chain but have
        // un-migrated hashed seeds in DbRoot. They are skipped until the DbRoot
        // creator (BWJfSKzEFxdfLMwG7chXxnyAHbZSh4STDFH62hobMt9j) runs migration.
        // After migration, readable hints will be in table_seeds and they'll appear automatically.

        const list = await iqlabs.reader.getTablelistFromRoot(
            this.connection,
            this.dbRootId,
        );
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);

        const rooms = [] as any[];
        const seedHexes = [
            ...new Set([...list.tableSeeds, ...list.globalTableSeeds]),
        ];
        for (const seedHex of seedHexes) {
            const rawBytes = Buffer.from(seedHex, "hex");
            const utf8 = rawBytes.toString("utf8");
            const isReadable = rawBytes.length < 32 && /^[\x20-\x7e]+$/.test(utf8);

            // Skip legacy 32-byte hashed seeds (un-migrated)
            if (!isReadable) continue;

            const pdaSeed = Buffer.from(iqlabs.utils.toSeedBytes(utf8));
            const table = iqlabs.contract.getTablePda(dbRoot, pdaSeed, this.programId);
            let name = isReadable ? utf8 : seedHex;
            const info = await this.connection.getAccountInfo(table);
            if (!info) continue;
            try {
                const decoded = this.accountCoder.decode("Table", info.data) as {
                    name: Uint8Array;
                };
                const decodedName = Buffer.from(decoded.name)
                    .toString("utf8")
                    .replace(/\0+$/, "")
                    .trim();
                if (decodedName) name = decodedName;
            } catch {}
            rooms.push({name, seed: pdaSeed, seedHex,
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
            undefined,
            undefined,
            trimmed,
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

    deriveDmSeed(partyA: string, partyB: string): Uint8Array {
        return iqlabs.utils.deriveDmSeed(partyA, partyB);
    }

    deriveConnectionTable(dmSeed: Uint8Array): PublicKey {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        return iqlabs.contract.getConnectionTablePda(dbRoot, dmSeed, this.programId);
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
