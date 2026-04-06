export const DB_ROOT_ID = "iqchan";
export const THREADS_PER_PAGE = 20;
export const BUMP_LIMIT = 300;
export const FEED_SEED_PREFIX = "feedmY}AGBJiqLabs";
export const BOARD_COLUMNS = ["sub", "com", "name", "time", "img", "threadPda", "threadSeed"];
export const BOARD_ID_COL = "time";
export const REPLY_PREVIEW_COUNT = 3;

export function threadTableSeed(boardId: string, randomId: string): string {
    return `${boardId}/thread/${randomId}`;
}

export interface Post {
    sub?: string;
    com: string;
    name: string;
    time: number;
    img?: string;
    threadPda?: string;
    threadSeed?: string;
    __txSignature?: string;
}

export interface ThreadEntry {
    threadPda: string;
    threadSeed?: string;
    opData: Post | null;
    lastActivityTime: number;
    replyCount: number;
    lastReplies: Post[];
}
