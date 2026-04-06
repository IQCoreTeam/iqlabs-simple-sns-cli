/**
 * Simple CLI logger helpers
 * ---------------------------------------------------------------------------
 * Purpose: centralize logging helpers so every CLI command prints consistently.
 */

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const CYAN = "\x1b[36m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const MAGENTA = "\x1b[35m";
export const WHITE = "\x1b[37m";
export const BG_CYAN = "\x1b[46m";
export const BG_DARK = "\x1b[40m";

export function logInfo(message: string, data?: unknown) {
    if (data === undefined) {
        console.log(`${CYAN}[info]${RESET} ${message}`)
        return
    }
    console.log(`${CYAN}[info]${RESET} ${message}`, data)
}

export function logWarn(message: string, data?: unknown) {
    if (data === undefined) {
        console.warn(`${YELLOW}[warn]${RESET} ${message}`)
        return
    }
    console.warn(`${YELLOW}[warn]${RESET} ${message}`, data)
}

export function logError(message: string, error?: unknown) {
    if (error === undefined) {
        console.error(`${RED}[error]${RESET} ${message}`)
        return
    }
    console.error(`${RED}[error]${RESET} ${message}`, error)
}

export function logSuccess(message: string, data?: unknown) {
    if (data === undefined) {
        console.log(`${GREEN}[ok]${RESET} ${message}`)
        return
    }
    console.log(`${GREEN}[ok]${RESET} ${message}`, data)
}

export function logStep(message: string) {
    console.log(`${DIM}>>>${RESET} ${message}`)
}

export function logTable(rows: unknown[]) {
    console.table(rows)
}
