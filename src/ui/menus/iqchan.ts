import {IqchanService} from "../../apps/iqchan/iqchan-service";
import type {Post, ThreadEntry} from "../../apps/iqchan/constants";
import {logError, logInfo, RESET, BOLD, DIM, CYAN, GREEN, YELLOW, MAGENTA, WHITE, RED} from "../../utils/logger";
import {prompt, selectFromList, closeReadline} from "../../utils/prompt";
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

    const sig = op.__txSignature ? shortenSig(op.__txSignature) : "???";
    const sub = op.sub ? `${op.sub} ` : "";

    if (selected) {
        return `${BOLD}${CYAN}  > ${WHITE}${sub}${RESET}${DIM}${sig} ${entry.replyCount}R${RESET}\n`;
    }
    return `${DIM}    ${sub}${sig} ${entry.replyCount}R${RESET}\n`;
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
        logInfo(`Thread created! https://solscan.io/tx/${result.txSignature}`);
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
        logInfo(`Reply posted! https://solscan.io/tx/${sig}`);
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
    const op = entry.opData;
    const replies: Post[] = [];

    const loadReplies = async (): Promise<boolean> => {
        try {
            const {replies: loaded} = await service.readThread(entry.threadPda, threadSeed, boardId);
            replies.length = 0;
            replies.push(...loaded);
            return true;
        } catch (err) {
            logError("Failed to load replies", err);
            return false;
        }
    };

    console.clear();
    logInfo("Loading replies...");
    if (!(await loadReplies())) {
        await prompt("Press Enter to go back...");
        return;
    }

    const render = () => {
        console.clear();
        const subject = op?.sub ?? "(no subject)";
        console.log(`  ${BOLD}${CYAN}/${boardId}/${RESET} ${BOLD}${WHITE}${subject}${RESET}`);
        console.log(`  ${DIM}${"─".repeat(70)}${RESET}`);
        console.log("");

        if (op) {
            const opLines = renderPost(op, 0, replies.length, true);
            for (const line of opLines) console.log(line);
        }

        replies.forEach((reply, i) => {
            const lines = renderPost(reply, i + 1, replies.length, false);
            for (const line of lines) console.log(line);
        });

        console.log(`  ${DIM}${replies.length} replies${RESET}`);
        console.log(`  ${DIM}${"─".repeat(70)}${RESET}`);
    };

    // Bottom bar actions with ←→ selection
    const actions: Array<{label: string; id: string}> = [];

    const rebuildActions = () => {
        actions.length = 0;
        actions.push({label: "Reply", id: "reply"});
        actions.push({label: "Back", id: "back"});
    };

    const drawBar = (sel: number) => {
        // Move cursor to bottom and redraw action bar
        const bar = actions.map((a, i) => {
            if (i === sel) return `${BOLD}${CYAN}[ ${WHITE}${a.label}${CYAN} ]${RESET}`;
            return `${DIM} ${a.label} ${RESET}`;
        }).join("  ");
        process.stdout.write(`\r  ${bar}  ${DIM}←→ select  Enter confirm${RESET}\x1b[K`);
    };

    const selectAction = async (): Promise<string | null> => {
        rebuildActions();
        render();
        let sel = 0;
        drawBar(sel);

        closeReadline();
        const readline = await import("node:readline");
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdin.resume();

        return new Promise<string | null>((resolve) => {
            const onKey = (_: string, key: any) => {
                if (key.name === "left") {
                    sel = (sel - 1 + actions.length) % actions.length;
                    drawBar(sel);
                } else if (key.name === "right") {
                    sel = (sel + 1) % actions.length;
                    drawBar(sel);
                } else if (key.name === "return") {
                    cleanup();
                    resolve(actions[sel].id);
                } else if (key.name === "escape" || key.sequence === "\x1b" || (key.ctrl && key.name === "c")) {
                    cleanup();
                    resolve("back");
                }
            };
            const cleanup = () => {
                stdin.off("keypress", onKey);
                stdin.setRawMode(Boolean(wasRaw));
                stdin.pause();
            };
            stdin.on("keypress", onKey);
        });
    };

    while (true) {
        const action = await selectAction();

        if (action === "back") break;

        if (action === "reply") {
            console.log("");
            await replyFlow(
                service,
                threadSeed,
                entry.threadPda,
                boardId,
                replies.length,
                op?.sub,
            );
            await loadReplies();
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

        logInfo("Loading threads...");
        const threads = await service.fetchFeedThreads(board.id);

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
