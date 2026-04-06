import {randomUUID} from "node:crypto";
import {PublicKey, SystemProgram} from "@solana/web3.js";
import type {Connection, Signer} from "@solana/web3.js";
import iqlabs from "@iqlabs-official/solana-sdk";

import {getWalletCtx} from "../../utils/wallet_manager";
import {sendInstruction} from "../../utils/tx";
import {logStep, logSuccess, logWarn} from "../../utils/logger";
import {
    DB_ROOT_ID,
    BOARD_COLUMNS,
    BOARD_ID_COL,
    BUMP_LIMIT,
    FEED_SEED_PREFIX,
    THREADS_PER_PAGE,
    REPLY_PREVIEW_COUNT,
    threadTableSeed,
    type Post,
    type ThreadEntry,
} from "./constants";

// ─── Pure helpers ────────────────────────────────────────────────────────────

function mergeInstructions(
    posts: Record<string, unknown>[],
    instructions: Record<string, unknown>[],
): Record<string, unknown>[] {
    if (instructions.length === 0) return posts;

    const byTarget = new Map<string, Record<string, unknown>[]>();
    for (const instr of instructions) {
        const target = instr.target as string | undefined;
        if (!target) continue;
        const list = byTarget.get(target);
        if (list) list.push(instr);
        else byTarget.set(target, [instr]);
    }

    const deleted = new Set<string>();
    const result = posts.map((post) => {
        const sig = post.__txSignature as string | undefined;
        if (!sig) return post;
        const instrList = byTarget.get(sig);
        if (!instrList) return post;

        let merged = {...post};
        for (const instr of instrList) {
            const dataKeys = Object.keys(instr).filter(
                (k) => k !== "target" && k !== "__txSignature",
            );
            if (dataKeys.length === 0) {
                deleted.add(sig);
                return merged;
            }
            if (instr.com !== undefined) {
                merged = {...merged, com: instr.com};
            }
        }
        return merged;
    });

    return result.filter((post) => {
        const sig = post.__txSignature as string | undefined;
        return !sig || !deleted.has(sig);
    });
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class IqchanService {
    readonly connection: Connection;
    readonly signer: Signer;
    readonly dbRootId: Uint8Array;
    readonly programId: PublicKey;
    readonly builder: ReturnType<typeof iqlabs.contract.createInstructionBuilder>;

    /** Cached DbRoot data — populated by fetchDbRoot() */
    private _tableSeeds: string[] = [];
    private _globalTableSeeds: string[] = [];
    /** boardId → thread hint list, built from global seeds */
    private _boardThreads: Map<string, string[]> = new Map();

    constructor() {
        const {connection, signer} = getWalletCtx();
        this.connection = connection;
        this.signer = signer;
        this.dbRootId = Buffer.from(iqlabs.utils.toSeedBytes(DB_ROOT_ID));
        this.programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
        this.builder = iqlabs.contract.createInstructionBuilder();
    }

    // ─── Setup ───────────────────────────────────────────────────────────────

    /** Read-only: fetch board list + thread index from DbRoot (1 RPC call) */
    async fetchDbRoot() {
        const list = await iqlabs.reader.getTablelistFromRoot(this.connection, this.dbRootId) as {
            tableSeeds: string[];
            globalTableSeeds: string[];
        };
        this._tableSeeds = list.tableSeeds;
        this._globalTableSeeds = list.globalTableSeeds;

        // Build board → threads map from global seeds
        // Threads are stored as "boardId/thread/uuid" hints
        this._boardThreads.clear();
        for (const seedHex of this._globalTableSeeds) {
            const hint = Buffer.from(seedHex, "hex").toString("utf8");
            const match = hint.match(/^([^/]+)\/thread\/(.+)$/);
            if (!match) continue;
            const boardId = match[1];
            const threads = this._boardThreads.get(boardId) || [];
            threads.push(hint);
            this._boardThreads.set(boardId, threads);
        }
    }

    /** Get cached thread hints for a board (no RPC) */
    getThreadsForBoard(boardId: string): string[] {
        return this._boardThreads.get(boardId) || [];
    }

    /** Write-ready: ensure user account exists on-chain (for posting) */
    async ensureWriteReady() {
        const user = this.signer.publicKey;
        const userInventory = iqlabs.contract.getUserInventoryPda(user, this.programId);
        const invInfo = await this.connection.getAccountInfo(userInventory);
        if (!invInfo) {
            logStep("Initializing user account...");
            logWarn("This requires a small amount of SOL.");
            const balance = await this.connection.getBalance(user);
            if (balance === 0) {
                throw new Error(
                    "Insufficient SOL balance — your wallet has 0 SOL.\n" +
                    `   Fund your wallet first: ${user.toBase58()}`
                );
            }
            const ix = iqlabs.contract.userInitializeInstruction(this.builder, {
                user,
                code_account: iqlabs.contract.getCodeAccountPda(user, this.programId),
                user_state: iqlabs.contract.getUserPda(user, this.programId),
                user_inventory: userInventory,
                system_program: SystemProgram.programId,
            });
            await sendInstruction(this.connection, this.signer, ix);
            logSuccess("User account initialized!");
        }
    }

    // ─── PDA ─────────────────────────────────────────────────────────────────

    getFeedPda(boardId: string): PublicKey {
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        return PublicKey.findProgramAddressSync(
            [
                Buffer.from(FEED_SEED_PREFIX),
                this.programId.toBuffer(),
                dbRoot.toBuffer(),
                Buffer.from(iqlabs.utils.toSeedBytes(boardId)),
            ],
            this.programId,
        )[0];
    }

    // ─── Reads ───────────────────────────────────────────────────────────────

    listBoards(): Array<{ id: string; title: string; description: string }> {
        // table_seeds now contain readable slugs ("po", "biz", etc.)
        // Decode hex → UTF-8 to get the slug, use as both id and title
        return this._tableSeeds.map((seedHex) => {
            const slug = Buffer.from(seedHex, "hex").toString("utf8");
            return {id: slug, title: slug, description: ""};
        });
    }

    /** List threads for a board from cached global seeds (no RPC) */
    listBoardThreads(boardId: string): ThreadEntry[] {
        const threadHints = this._boardThreads.get(boardId) || [];
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);

        return threadHints.map((hint) => {
            const seedBytes = Buffer.from(iqlabs.utils.toSeedBytes(hint));
            const threadPda = iqlabs.contract.getTablePda(dbRoot, seedBytes, this.programId);
            return {
                threadPda: threadPda.toBase58(),
                threadSeed: hint,
                opData: null,
                lastActivityTime: 0,
                replyCount: 0,
                lastReplies: [],
            };
        });
    }

    async fetchFeedThreads(boardId: string): Promise<ThreadEntry[]> {
        const feedPda = this.getFeedPda(boardId);
        const feedRows = await iqlabs.reader.readTableRows(feedPda, {
            limit: THREADS_PER_PAGE * 3,
        });

        const threads = new Map<string, ThreadEntry>();

        for (const row of feedRows) {
            const post = row as unknown as Post;
            if (!post.threadPda) continue;

            const time = post.time ?? 0;
            const existing = threads.get(post.threadPda);

            if (existing) {
                if (!existing.opData || time < existing.opData.time) {
                    existing.opData = post;
                }
                existing.lastActivityTime = Math.max(existing.lastActivityTime, time);
                if (!existing.threadSeed && post.threadSeed) {
                    existing.threadSeed = post.threadSeed;
                }
            } else {
                threads.set(post.threadPda, {
                    threadPda: post.threadPda,
                    threadSeed: post.threadSeed,
                    opData: post,
                    lastActivityTime: time,
                    replyCount: 0,
                    lastReplies: [],
                });
            }
        }

        // Fetch reply previews for each thread
        await Promise.all(
            [...threads.values()].map(async (entry) => {
                try {
                    const rows = await iqlabs.reader.readTableRows(entry.threadPda, {
                        limit: 50,
                    });

                    const opFromRows = (rows as unknown as Post[])
                        .filter((r) => !!r.threadSeed)
                        .reduce<Post | undefined>(
                            (a, b) => (!a || b.time < a.time ? b : a),
                            undefined,
                        );
                    if (opFromRows && !entry.opData) entry.opData = opFromRows;
                    if (opFromRows?.threadSeed && !entry.threadSeed) {
                        entry.threadSeed = opFromRows.threadSeed;
                    }

                    const opSig = entry.opData?.__txSignature ?? opFromRows?.__txSignature;
                    const replies = (rows as unknown as Post[])
                        .filter((r) => r.__txSignature !== opSig)
                        .sort((a, b) => a.time - b.time);

                    entry.replyCount = replies.length;
                    entry.lastReplies = replies.slice(-REPLY_PREVIEW_COUNT);
                } catch {
                    // skip threads that fail to load
                }
            }),
        );

        return [...threads.values()]
            .filter((t) => t.opData !== null)
            .sort((a, b) => b.lastActivityTime - a.lastActivityTime);
    }

    async readThread(
        threadPda: string,
        threadSeed: string,
        boardId?: string,
    ): Promise<{ op: Post | null; replies: Post[] }> {
        const rows = await iqlabs.reader.readTableRows(threadPda);
        const posts = rows as unknown as Post[];

        // Try to get OP from feed if boardId is provided
        let feedOp: Post | undefined;
        if (boardId) {
            try {
                const feedPda = this.getFeedPda(boardId);
                const feedRows = await iqlabs.reader.readTableRows(feedPda, {limit: 100});
                feedOp = (feedRows as unknown as Post[]).find(
                    (r) => r.threadPda === threadPda && !!r.threadSeed,
                );
            } catch {
                // ignore feed read errors
            }
        }

        // Fetch and merge edit/delete instructions
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const instrSeed = Buffer.from(iqlabs.utils.toSeedBytes(threadSeed));
        const instrTable = iqlabs.contract.getInstructionTablePda(dbRoot, instrSeed, this.programId);

        let instrRows: Record<string, unknown>[] = [];
        try {
            instrRows = await iqlabs.reader.readTableRows(instrTable);
        } catch {
            // no instructions yet
        }

        const merged = mergeInstructions(rows, instrRows) as unknown as Post[];

        // Find OP: has threadSeed + earliest time
        let op = merged
            .filter((r) => !!r.threadSeed)
            .sort((a, b) => a.time - b.time)[0] ?? feedOp ?? null;

        const opSig = op?.__txSignature;
        const replies = merged
            .filter((r) => r.__txSignature !== opSig)
            .sort((a, b) => a.time - b.time);

        return {op, replies};
    }

    /** Fetch all signatures for a thread PDA (1 RPC call, up to 1000) */
    async fetchThreadSignatures(threadPda: string): Promise<string[]> {
        return iqlabs.reader.collectSignatures(threadPda, 1000);
    }

    /** Read a single tx signature into a Post (1 RPC call) */
    async readSinglePost(sig: string): Promise<Post | null> {
        try {
            const {data} = await iqlabs.reader.readCodeIn(sig);
            if (!data) return null;
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return {...parsed, __txSignature: sig} as Post;
            }
        } catch {}
        return null;
    }

    // ─── Writes ──────────────────────────────────────────────────────────────

    async createThread(
        boardId: string,
        data: { sub: string; com: string; name: string; img?: string },
    ): Promise<{ threadSeed: string; txSignature: string }> {
        const rid = randomUUID();
        const seed = threadTableSeed(boardId, rid);
        const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
        const seedBytes = Buffer.from(iqlabs.utils.toSeedBytes(seed));
        const boardSeedBytes = Buffer.from(iqlabs.utils.toSeedBytes(boardId));
        const tablePda = iqlabs.contract.getTablePda(dbRoot, seedBytes, this.programId);
        const instrPda = iqlabs.contract.getInstructionTablePda(dbRoot, seedBytes, this.programId);
        const feedPda = this.getFeedPda(boardId);

        // TX1: Create thread ext table
        const ix = iqlabs.contract.createExtTableInstruction(
            this.builder,
            {
                signer: this.signer.publicKey,
                db_root: dbRoot,
                table: tablePda,
                instruction_table: instrPda,
                system_program: SystemProgram.programId,
            },
            {
                db_root_id: this.dbRootId,
                table_seed: seedBytes,
                table_hint: Buffer.from(seed),
                table_name: Buffer.from(seed),
                column_names: BOARD_COLUMNS.map((c) => Buffer.from(c)),
                id_col: Buffer.from(BOARD_ID_COL),
                ext_keys: [],
                gate_opt: null,
                writers_opt: null,
            },
        );
        await sendInstruction(this.connection, this.signer, ix);

        // TX2: Write OP row to board table with feed bump
        const row = {
            sub: data.sub,
            com: data.com,
            name: data.name,
            time: Math.floor(Date.now() / 1000),
            ...(data.img ? {img: data.img} : {}),
            threadPda: tablePda.toBase58(),
            threadSeed: seed,
        };

        const txSignature = await iqlabs.writer.writeRow(
            this.connection,
            this.signer,
            this.dbRootId,
            boardSeedBytes,
            JSON.stringify(row),
            false,
            [feedPda],
        );

        return {threadSeed: seed, txSignature};
    }

    async postReply(
        threadSeed: string,
        threadPda: string,
        boardId: string,
        data: { com: string; name: string; img?: string },
        replyCount = 0,
    ): Promise<string> {
        const seedBytes = Buffer.from(iqlabs.utils.toSeedBytes(threadSeed));
        const shouldBump = replyCount < BUMP_LIMIT;
        const remaining = shouldBump ? [this.getFeedPda(boardId)] : [];

        const row = {
            sub: "",
            com: data.com,
            name: data.name,
            time: Math.floor(Date.now() / 1000),
            ...(data.img ? {img: data.img} : {}),
            threadPda,
            threadSeed,
        };

        return iqlabs.writer.writeRow(
            this.connection,
            this.signer,
            this.dbRootId,
            seedBytes,
            JSON.stringify(row),
            false,
            remaining,
        );
    }

    async editPost(threadSeed: string, targetTxSig: string, newCom: string): Promise<string> {
        const seedBytes = Buffer.from(iqlabs.utils.toSeedBytes(threadSeed));
        return iqlabs.writer.manageRowData(
            this.connection,
            this.signer,
            this.dbRootId,
            seedBytes,
            JSON.stringify({target: targetTxSig, com: newCom}),
            threadSeed,
            targetTxSig,
        );
    }

    async deletePost(threadSeed: string, targetTxSig: string): Promise<string> {
        const seedBytes = Buffer.from(iqlabs.utils.toSeedBytes(threadSeed));
        return iqlabs.writer.manageRowData(
            this.connection,
            this.signer,
            this.dbRootId,
            seedBytes,
            "{}",
            threadSeed,
            targetTxSig,
        );
    }
}
