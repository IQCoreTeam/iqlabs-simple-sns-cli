import {IqchanService} from "../../apps/iqchan/iqchan-service";
import type {Post, ThreadEntry} from "../../apps/iqchan/constants";
import {logError, logInfo, RESET, BOLD, DIM, CYAN, GREEN, YELLOW, MAGENTA, WHITE, RED} from "../../utils/logger";
import {prompt, selectFromList} from "../../utils/prompt";
import {formatDate, timeAgo, truncate, shortenSig} from "../../utils/format";

const PAGE_SIZE = 20;

// ─── Renderers ───────────────────────────────────────────────────────────────

function renderThreadPreview(entry: ThreadEntry, selected: boolean): string {
    const op = entry.opData;

    if (!op) {
        const seed = entry.threadSeed ?? entry.threadPda;
        // Parse board/thread/uuid → show uuid part
        const parts = seed.split("/");
        const uuid = parts.length >= 3 ? parts[2].slice(0, 8) : seed.slice(0, 12);
        const board = parts[0] || "";

        if (selected) {
            return `${BOLD}${CYAN}  > ${WHITE}Thread ${uuid}  ${DIM}/${board}/${RESET}\n`;
        }
        return `${DIM}    Thread ${uuid}  /${board}/${RESET}\n`;
    }

    const sub = op.sub ? op.sub : "(no subject)";
    const preview = truncate(op.com ?? "", 60);
    const meta = `${op.name} ${DIM}${timeAgo(op.time)} ${entry.replyCount}R${RESET}`;

    if (selected) {
        const lines = [`${BOLD}${CYAN}  > ${WHITE}${sub} ${RESET}${DIM}[${meta}]${RESET}`];
        if (preview) lines.push(`${CYAN}    │ ${RESET}${preview}`);
        if (entry.lastReplies.length > 0) {
            entry.lastReplies.forEach((reply, i) => {
                const isLast = i === entry.lastReplies.length - 1;
                const branch = isLast ? "└─" : "├─";
                const text = truncate(reply.com ?? "", 50);
                lines.push(`${CYAN}    ${branch}${RESET} ${DIM}${reply.name}:${RESET} ${text}`);
            });
        }
        lines.push("");
        return lines.join("\n");
    }

    const lines = [`${DIM}    ${sub} [${meta}]${RESET}`];
    lines.push("");
    return lines.join("\n");
}

function renderPost(
    post: Post,
    index: number,
    total: number,
    isOp: boolean,
): string[] {
    const sig = post.__txSignature ? shortenSig(post.__txSignature) : "???";
    const lines: string[] = [];

    if (isOp) {
        lines.push(`  ${BOLD}${GREEN}┌─ OP ${RESET}${DIM}${post.name} | ${formatDate(post.time)} | ${sig}${RESET}`);
        if (post.sub) {
            lines.push(`  ${GREEN}│${RESET} ${BOLD}${WHITE}${post.sub}${RESET}`);
        }
        const commentLines = (post.com ?? "").split("\n");
        for (const line of commentLines) {
            lines.push(`  ${GREEN}│${RESET} ${line}`);
        }
        if (post.img) {
            lines.push(`  ${GREEN}│${RESET} ${CYAN}[img: ${post.img}]${RESET}`);
        }
        lines.push(`  ${GREEN}└──────${RESET}`);
    } else {
        const isLast = index === total;
        const color = index % 2 === 0 ? CYAN : MAGENTA;
        lines.push(`  ${color}┌─ #${index}${RESET} ${DIM}${post.name} | ${formatDate(post.time)} | ${sig}${RESET}`);
        const commentLines = (post.com ?? "").split("\n");
        for (const line of commentLines) {
            lines.push(`  ${color}│${RESET} ${line}`);
        }
        if (post.img) {
            lines.push(`  ${color}│${RESET} ${CYAN}[img: ${post.img}]${RESET}`);
        }
        lines.push(`  ${color}└──────${RESET}`);
    }

    lines.push("");
    return lines;
}

// ─── Flows ───────────────────────────────────────────────────────────────────

async function createThreadFlow(service: IqchanService, boardId: string) {
    console.log(`\n── New Thread on /${boardId}/ ──`);
    const name = (await prompt("Name (default: Anonymous): ")).trim() || "Anonymous";
    const sub = (await prompt("Subject: ")).trim();
    const com = (await prompt("Comment: ")).trim();
    if (!com) {
        logError("Comment is required");
        return;
    }
    const img = (await prompt("Image URL (optional): ")).trim() || undefined;

    logInfo("Posting... (1/2 creating thread table)");
    try {
        await service.ensureWriteReady();
        const result = await service.createThread(boardId, {sub, com, name, img});
        logInfo("Posting... (2/2 writing post)");
        logInfo(`Thread created! sig: ${shortenSig(result.txSignature)}`);
    } catch (err) {
        logError("Failed to create thread", err);
    }
    await prompt("Press Enter to continue...");
}

async function replyFlow(
    service: IqchanService,
    threadSeed: string,
    threadPda: string,
    boardId: string,
    replyCount: number,
    opSubject?: string,
) {
    const title = opSubject ? `"${truncate(opSubject, 40)}"` : "thread";
    console.log(`\n── Reply to ${title} ──`);
    const name = (await prompt("Name (default: Anonymous): ")).trim() || "Anonymous";
    const com = (await prompt("Comment: ")).trim();
    if (!com) {
        logError("Comment is required");
        return;
    }
    const img = (await prompt("Image URL (optional): ")).trim() || undefined;

    logInfo("Posting reply...");
    try {
        await service.ensureWriteReady();
        const sig = await service.postReply(threadSeed, threadPda, boardId, {com, name, img}, replyCount);
        logInfo(`Reply posted! sig: ${shortenSig(sig)}`);
    } catch (err) {
        logError("Failed to post reply", err);
    }
    await prompt("Press Enter to continue...");
}

// ─── Thread View ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;

async function showThread(
    service: IqchanService,
    entry: ThreadEntry,
    boardId: string,
) {
    const threadSeed = entry.threadSeed ?? "";

    // 1. Fetch all signatures at once (1 RPC)
    console.clear();
    logInfo("Fetching tx list...");
    let allSigs: string[];
    try {
        allSigs = await service.fetchThreadSignatures(entry.threadPda);
    } catch (err) {
        logError("Failed to fetch thread", err);
        await prompt("Press Enter to go back...");
        return;
    }

    if (allSigs.length === 0) {
        logInfo("Empty thread");
        await prompt("Press Enter to go back...");
        return;
    }

    // Reverse so newest first in the sig list; we'll load newest first
    allSigs.reverse();

    // 2. Load posts incrementally
    const loaded: Post[] = [];
    let cursor = 0;

    const loadBatch = async () => {
        const batch = allSigs.slice(cursor, cursor + BATCH_SIZE);
        for (const sig of batch) {
            process.stdout.write(`\r  Fetching... ${loaded.length + 1}/${allSigs.length}`);
            const post = await service.readSinglePost(sig);
            if (post) loaded.push(post);
            cursor++;
            await new Promise(r => setTimeout(r, 1000));
        }
        console.log("");
    };

    // Initial load: newest 5
    await loadBatch();

    const render = () => {
        console.clear();
        const op = loaded.find(p => !!p.threadSeed);
        const subject = op?.sub ?? "(no subject)";
        console.log(`  ${BOLD}${CYAN}/${boardId}/${RESET} ${BOLD}${WHITE}${subject}${RESET}`);
        console.log(`  ${DIM}${"─".repeat(70)}${RESET}`);
        console.log("");

        if (op) {
            const opLines = renderPost(op, 0, loaded.length - 1, true);
            for (const line of opLines) console.log(line);
        }

        const replies = loaded.filter(p => p !== op).sort((a, b) => a.time - b.time);
        replies.forEach((reply, i) => {
            const lines = renderPost(reply, i + 1, replies.length, false);
            for (const line of lines) console.log(line);
        });

        const remaining = allSigs.length - cursor;
        console.log(`  ${DIM}Loaded ${loaded.length}/${allSigs.length} posts${RESET}`);
        console.log(`  ${DIM}${"─".repeat(70)}${RESET}`);
        const options: string[] = [];
        if (remaining > 0) options.push(`${YELLOW}[M]${RESET}ore (${remaining})`);
        options.push(`${GREEN}[R]${RESET}eply`);
        options.push(`${DIM}[B]ack${RESET}`);
        console.log(`  ${options.join("  ")}`);
    };

    render();

    while (true) {
        const input = (await prompt("> ")).trim().toLowerCase();

        if (input === "b" || input === "back") break;

        if (input === "m" || input === "more") {
            if (cursor >= allSigs.length) {
                logInfo("All posts loaded");
                continue;
            }
            await loadBatch();
            render();
            continue;
        }

        if (input === "r" || input === "reply") {
            await replyFlow(
                service,
                threadSeed,
                entry.threadPda,
                boardId,
                loaded.length,
                loaded.find(p => !!p.threadSeed)?.sub,
            );
            render();
            continue;
        }
    }
}

// ─── Board Threads ───────────────────────────────────────────────────────────

async function showBoardThreads(
    service: IqchanService,
    board: { id: string; title: string },
) {
    while (true) {
        console.clear();
        console.log(`/${board.id}/ - ${board.title}`);
        console.log(`${"─".repeat(75)}`);

        const threads = service.listBoardThreads(board.id);

        if (threads.length === 0) {
            logInfo("No threads yet");
            console.log("\n[N] New Thread  Esc/Enter = back");
            const input = (await prompt("> ")).trim().toLowerCase();
            if (input === "n") {
                await createThreadFlow(service, board.id);
                continue;
            }
            return;
        }

        const index = await selectFromList(
            `  ${BOLD}${CYAN}/${board.id}/${RESET} ${board.title}  ${DIM}|  [N]ew Thread${RESET}`,
            threads,
            (entry: ThreadEntry, selected: boolean) => renderThreadPreview(entry, selected),
        );

        if (index === null) return;

        await showThread(service, threads[index], board.id);
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export const runIqchanMenu = async () => {
    const service = new IqchanService();

    try {
        await service.fetchDbRoot();
    } catch (err) {
        logError("Failed to load boards", err);
        await prompt("Press Enter to return...");
        return;
    }

    while (true) {
        let boards: Array<{ id: string; title: string; description: string }>;
        try {
            boards = service.listBoards();
        } catch (err) {
            logError("Failed to load boards", err);
            await prompt("Press Enter to return...");
            return;
        }

        const index = await selectFromList(
            `  ${BOLD}${CYAN}╔══════════════════════════╗${RESET}\n  ${BOLD}${CYAN}║        IQChan            ║${RESET}\n  ${BOLD}${CYAN}╚══════════════════════════╝${RESET}`,
            boards,
            (board, selected) => {
                if (selected) return `${BOLD}${CYAN}  > ${WHITE}/${board.id}/${RESET} ${board.title}`;
                return `${DIM}    /${board.id}/ - ${board.title}${RESET}`;
            },
        );

        if (index === null) return;

        await showBoardThreads(service, boards[index]);
    }
};
