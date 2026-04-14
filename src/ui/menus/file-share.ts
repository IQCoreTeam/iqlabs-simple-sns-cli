import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import iqlabs from "@iqlabs-official/solana-sdk";

import {
    FileShareService,
    type PlazaFolder,
    type SpeedProfile,
} from "../../apps/file-share/file-share-service";
import {timeAgo, truncate, shortenSig} from "../../utils/format";
import {
    BOLD, CYAN, DIM, GREEN, MAGENTA, RED, RESET, WHITE, YELLOW,
    logError, logInfo, logStep, logSuccess,
} from "../../utils/logger";
import {prompt, selectFromList} from "../../utils/prompt";
import {finishProgressBar, renderProgressBar} from "../widgets/progress-bar";

const SPEED_PROFILES: SpeedProfile[] = ["light", "medium", "heavy", "extreme"];

// Default to "light" everywhere. We used to bump Helius up to "medium"
// automatically, but free/low-tier Helius keys still get 429s at 50 RPS,
// and the SDK only does fixed-delay retries — once you fall behind, the
// upload fails. "light" (2 RPS) is the only profile that's safe across
// all Helius tiers. Users on a beefy paid plan can opt into medium/heavy
// from Speed settings.
const computeDefaultSpeed = (): SpeedProfile => "light";

// Resolve user-typed file/dir paths: expand ~ and resolve relative paths.
const expandPath = (input: string): string => {
    const trimmed = input.trim().replace(/^['"]|['"]$/g, "");
    if (!trimmed) return trimmed;
    const expanded = trimmed.startsWith("~")
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;
    return path.resolve(expanded);
};

const downloadsDir = () => path.join(os.homedir(), "Downloads");

const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

// Split "foo.tar.gz" into ("foo.tar", "gz"). For names with no dot or
// dot-only files (".env"), we hand back the whole name as `name` and an
// empty `ext` so the row schema stays useful.
const splitFilename = (filename: string): {name: string; ext: string} => {
    const dot = filename.lastIndexOf(".");
    if (dot <= 0 || dot === filename.length - 1) return {name: filename, ext: ""};
    return {name: filename.slice(0, dot), ext: filename.slice(dot + 1)};
};

// Promp the user for a file path, expand it, stat it. Used by both upload
// flows so the file-picking ergonomics are identical.
const pickFile = async (): Promise<{filePath: string; stat: fs.Stats} | null> => {
    const raw = (await prompt("file path (~ ok): ")).trim();
    if (!raw) {
        logInfo("cancelled");
        return null;
    }
    const filePath = expandPath(raw);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        logError(`can't read ${filePath}`, err instanceof Error ? err.message : String(err));
        await prompt("Press Enter to continue...");
        return null;
    }
    if (!stat.isFile()) {
        logError(`not a regular file: ${filePath}`);
        await prompt("Press Enter to continue...");
        return null;
    }
    return {filePath, stat};
};

const printFileInfo = (filePath: string, stat: fs.Stats) => {
    // base64 expands by ~33%; chunk size is 850 bytes.
    const base64Bytes = Math.ceil((stat.size * 4) / 3);
    const expectedChunks = Math.max(1, Math.ceil(base64Bytes / 850));
    console.log(`  ${DIM}path:  ${RESET}${filePath}`);
    console.log(`  ${DIM}size:  ${RESET}${formatBytes(stat.size)}  ${DIM}(~${expectedChunks} chunks)${RESET}`);
};

// Run the actual upload + progress bar. Returns the codeIn signature, or
// null on failure / cancel. Centralized so both inventory and plaza paths
// behave identically.
const runUpload = async (
    service: FileShareService,
    filePath: string,
    speed: SpeedProfile,
): Promise<string | null> => {
    console.log();
    let signature: string;
    try {
        signature = await service.uploadFile(filePath, speed, (pct) => {
            renderProgressBar(pct, "upload");
        });
        renderProgressBar(100, "upload");
    } catch (err) {
        finishProgressBar();
        const msg = err instanceof Error ? err.message : String(err);
        logError("upload failed", msg);
        if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
            console.log(
                `  ${YELLOW}hint:${RESET} your RPC is rate-limiting us. drop speed to 'light'`,
            );
            console.log(
                `        from Speed settings and try again. partial chunks on chain`,
            );
            console.log(
                `        are harmless — a fresh upload starts a new session.`,
            );
        }
        await prompt("Press Enter to continue...");
        return null;
    }
    finishProgressBar();
    return signature;
};

// ── Upload destination picker ───────────────────────────────────────────────
const pickUploadDestination = async (): Promise<"inventory" | "plaza" | null> => {
    const items = [
        {label: "My Inventory", value: "inventory" as const},
        {label: "IQ Plaza", sub: "the degen dump - public, unmoderated", value: "plaza" as const},
        {label: "Back", value: null},
    ];
    const idx = await selectFromList(
        `${BOLD}${CYAN}where to upload?${RESET}`,
        items,
        (item, selected) => {
            const marker = selected ? `${CYAN}>${RESET}` : " ";
            if (item.value === null) return `  ${DIM}${marker} Back${RESET}`;
            const sub = (item as {sub?: string}).sub
                ? `  ${DIM}${(item as {sub?: string}).sub}${RESET}`
                : "";
            return `${marker} ${WHITE}${item.label}${RESET}${sub}`;
        },
    );
    if (idx === null) return null;
    return items[idx].value;
};

// ── Upload to inventory (private to no one - just your wallet's tx history) ─
const uploadToInventoryFlow = async (service: FileShareService, speed: SpeedProfile) => {
    console.clear();
    console.log(`${BOLD}${CYAN}upload to my inventory${RESET}  ${DIM}(speed: ${speed})${RESET}`);
    console.log();

    const picked = await pickFile();
    if (!picked) return;
    const {filePath, stat} = picked;
    console.log();
    printFileInfo(filePath, stat);
    console.log();

    const confirm = (await prompt("upload? (y/N): ")).trim().toLowerCase();
    if (confirm !== "y") {
        logInfo("cancelled");
        return;
    }

    const signature = await runUpload(service, filePath, speed);
    if (!signature) return;

    console.log();
    logSuccess("upload complete. on chain forever.");
    console.log(`  ${BOLD}signature:${RESET} ${GREEN}${signature}${RESET}`);
    console.log(`  ${DIM}share this sig with anyone for 'Download by signature'.${RESET}`);
    console.log();
    await prompt("Press Enter to continue...");
};

// ── Upload to IQ Plaza (public folder of your choice) ──────────────────────
const uploadToPlazaFlow = async (service: FileShareService, speed: SpeedProfile) => {
    console.clear();
    printPlazaWarning();
    console.log();

    const folder = await pickOrCreatePlazaFolder(service);
    if (!folder) return;

    // private folder + not the owner = no point continuing.
    if (!folder.isPublic && folder.ownerLabel !== "you") {
        const me = `${service.signer.publicKey.toBase58().slice(0, 4)}...${service.signer.publicKey.toBase58().slice(-4)}`;
        if (folder.ownerLabel !== me) {
            logError(`'${folder.name}/' is private. only ${folder.ownerLabel} can upload here.`);
            await prompt("Press Enter to continue...");
            return;
        }
    }

    console.clear();
    console.log(`${BOLD}${CYAN}upload to IQ Plaza/${folder.name}/${RESET}  ${DIM}${folderTag(folder)}${RESET}`);
    console.log();

    const picked = await pickFile();
    if (!picked) return;
    const {filePath, stat} = picked;
    const {name, ext} = splitFilename(path.basename(filePath));

    console.log();
    printFileInfo(filePath, stat);
    console.log();
    console.log(
        `  ${YELLOW}heads up:${RESET} this folder is ${folder.isPublic ? "public" : "private"}. your wallet`,
    );
    console.log(
        `            (${shortenSig(service.signer.publicKey.toBase58())}) is stamped on chain forever.`,
    );
    console.log(`            no delete button. there will never be a delete button.`);
    console.log();

    const confirm = (await prompt("continue? (y/N): ")).trim().toLowerCase();
    if (confirm !== "y") {
        logInfo("cancelled");
        return;
    }

    // step 1: upload the bytes
    const signature = await runUpload(service, filePath, speed);
    if (!signature) return;

    // step 2: index it in the folder
    console.log();
    logStep(`indexing in ${folder.name}/...`);
    let rowSig: string;
    try {
        rowSig = await service.writePlazaFileRow(folder.seed, {name, ext, sig: signature});
    } catch (err) {
        logError("failed to write folder row", err);
        console.log(`  ${DIM}your file is still uploaded as sig:${RESET} ${signature}`);
        console.log(`  ${DIM}you can use 'Download by signature' to fetch it directly.${RESET}`);
        await prompt("Press Enter to continue...");
        return;
    }

    console.log();
    logSuccess(`${name}${ext ? "." + ext : ""} dropped into ${folder.name}/`);
    console.log(`  ${DIM}file sig:${RESET} ${GREEN}${signature}${RESET}`);
    console.log(`  ${DIM}row sig: ${RESET}${DIM}${rowSig}${RESET}`);
    console.log();
    await prompt("Press Enter to continue...");
};

const pickOrCreatePlazaFolder = async (
    service: FileShareService,
): Promise<PlazaFolder | null> => {
    logStep("loading IQ Plaza folders...");
    let folders: PlazaFolder[];
    try {
        folders = await service.listPlazaFolders();
    } catch (err) {
        logError("couldn't list folders", err);
        await prompt("Press Enter to continue...");
        return null;
    }

    while (true) {
        type Item =
            | {kind: "folder"; folder: PlazaFolder}
            | {kind: "create"}
            | {kind: "back"};
        const items: Item[] = [
            ...folders.map((f) => ({kind: "folder" as const, folder: f})),
            {kind: "create" as const},
            {kind: "back" as const},
        ];

        const idx = await selectFromList(
            `${BOLD}${CYAN}IQ Plaza${RESET}  ${DIM}the degen dump (${folders.length} folders)${RESET}\n${DIM}fyi: public folders eat uploads from any wallet. you've been warned.${RESET}`,
            items,
            (item, selected) => {
                const marker = selected ? `${CYAN}>${RESET}` : " ";
                if (item.kind === "create") {
                    return `${marker} ${GREEN}+ create new folder${RESET}`;
                }
                if (item.kind === "back") {
                    return `${marker} ${DIM}Back${RESET}`;
                }
                const f = item.folder;
                return `${marker} ${WHITE}${f.name}/${RESET}  ${folderTag(f)}`;
            },
        );
        if (idx === null) return null;
        const chosen = items[idx];
        if (chosen.kind === "back") return null;
        if (chosen.kind === "folder") return chosen.folder;
        // create
        const made = await createPlazaFolderFlow(service);
        if (made) {
            // re-list so the new folder appears with its real metadata.
            try {
                folders = await service.listPlazaFolders();
            } catch {
                /* keep stale list */
            }
            return made;
        }
        // user cancelled — re-render the picker
    }
};

const createPlazaFolderFlow = async (
    service: FileShareService,
): Promise<PlazaFolder | null> => {
    console.clear();
    console.log(`${BOLD}${CYAN}create folder in IQ Plaza${RESET}`);
    console.log(`${DIM}name must match [a-zA-Z0-9_-]+, 1..30 chars. no spaces, sorry.${RESET}`);
    console.log();

    const name = (await prompt("folder name: ")).trim();
    if (!name) {
        logInfo("cancelled");
        return null;
    }
    if (!/^[a-zA-Z0-9_-]{1,30}$/.test(name)) {
        logError("invalid name. allowed: a-z A-Z 0-9 _ - (1..30 chars)");
        await prompt("Press Enter to continue...");
        return null;
    }

    const visibilityItems = [
        {label: "public",  sub: "anyone can dump files here", value: true},
        {label: "private", sub: "only your wallet can upload (others can browse)", value: false},
        {label: "Cancel",  sub: "", value: null as null | boolean},
    ];
    const visIdx = await selectFromList(
        `visibility for '${name}/'  ${DIM}(set in stone, no take-backs)${RESET}`,
        visibilityItems,
        (item, selected) => {
            const marker = selected ? `${CYAN}>${RESET}` : " ";
            if (item.value === null) return `  ${DIM}${marker} Cancel${RESET}`;
            return `${marker} ${WHITE}${item.label}${RESET}  ${DIM}${item.sub}${RESET}`;
        },
    );
    if (visIdx === null || visibilityItems[visIdx].value === null) {
        logInfo("cancelled");
        return null;
    }
    const isPublic = visibilityItems[visIdx].value as boolean;

    logStep(`creating folder '${name}' (${isPublic ? "public" : "private"})...`);
    try {
        const result = await service.createPlazaFolder(name, isPublic);
        if (!result.created) {
            logInfo(`folder '${name}' already exists. using it.`);
        } else {
            logSuccess(`created. tx: ${shortenSig(result.signature)}`);
        }
        return result.folder;
    } catch (err) {
        logError("create folder failed", err);
        await prompt("Press Enter to continue...");
        return null;
    }
};

const folderTag = (f: PlazaFolder): string => {
    if (f.isPublic) return `${GREEN}[public]${RESET}`;
    return `${DIM}[${f.ownerLabel}]${RESET}`;
};

const printPlazaWarning = () => {
    console.log(`${BOLD}${CYAN}IQ Plaza${RESET}  ${DIM}the degen dump${RESET}`);
    console.log();
    console.log(`  yo. this is the public IQDB drop. anyone can push files to any`);
    console.log(`  public folder. uploads are permanent and unmoderated.`);
    console.log(`  trust nothing. validate after download.`);
    console.log(`  ${DIM}TODO: planned - credit score from uploader IQ holdings${RESET}`);
};

// ── Browse IQ Plaza (read-only entry) ──────────────────────────────────────
const browsePlazaFlow = async (service: FileShareService, speed: SpeedProfile) => {
    while (true) {
        console.clear();
        printPlazaWarning();
        console.log();

        logStep("loading folders...");
        let folders: PlazaFolder[];
        try {
            folders = await service.listPlazaFolders();
        } catch (err) {
            logError("couldn't list folders", err);
            await prompt("Press Enter to continue...");
            return;
        }
        if (folders.length === 0) {
            logInfo("no folders yet. create one from 'Upload file -> IQ Plaza'.");
            await prompt("Press Enter to continue...");
            return;
        }

        type Item = {kind: "folder"; folder: PlazaFolder} | {kind: "back"};
        const items: Item[] = [
            ...folders.map((f) => ({kind: "folder" as const, folder: f})),
            {kind: "back" as const},
        ];

        const idx = await selectFromList(
            `${BOLD}${CYAN}IQ Plaza${RESET}  ${DIM}${folders.length} folders${RESET}`,
            items,
            (item, selected) => {
                const marker = selected ? `${CYAN}>${RESET}` : " ";
                if (item.kind === "back") return `  ${DIM}${marker} Back${RESET}`;
                const f = item.folder;
                const when = f.lastTimestamp ? timeAgo(f.lastTimestamp) : "no activity";
                return `${marker} ${WHITE}${f.name}/${RESET}  ${folderTag(f)}  ${DIM}${when}${RESET}`;
            },
        );
        if (idx === null) return;
        const chosen = items[idx];
        if (chosen.kind === "back") return;
        await browsePlazaFolder(service, chosen.folder, speed);
    }
};

const browsePlazaFolder = async (
    service: FileShareService,
    folder: PlazaFolder,
    speed: SpeedProfile,
) => {
    while (true) {
        console.clear();
        console.log(`${BOLD}${CYAN}${folder.name}/${RESET}  ${folderTag(folder)}`);
        console.log(`  ${DIM}note: anyone could have uploaded these. validate after download.${RESET}`);
        console.log();

        logStep("loading files...");
        let files: Awaited<ReturnType<typeof service.listPlazaFiles>>;
        try {
            files = await service.listPlazaFiles(folder.seed);
        } catch (err) {
            logError("couldn't read folder", err);
            await prompt("Press Enter to continue...");
            return;
        }
        if (files.length === 0) {
            logInfo(`${folder.name}/ is empty. be the first to dump something.`);
            await prompt("Press Enter to continue...");
            return;
        }

        type Item =
            | {kind: "file"; file: typeof files[number]}
            | {kind: "back"};
        const items: Item[] = [
            ...files.map((f) => ({kind: "file" as const, file: f})),
            {kind: "back" as const},
        ];

        const idx = await selectFromList(
            `${BOLD}${CYAN}${folder.name}/${RESET}  ${DIM}${files.length} files${RESET}`,
            items,
            (item, selected) => {
                const marker = selected ? `${CYAN}>${RESET}` : " ";
                if (item.kind === "back") return `  ${DIM}${marker} Back${RESET}`;
                const f = item.file;
                const fname = f.ext ? `${f.name}.${f.ext}` : f.name;
                const when = f.timestamp ? timeAgo(Math.floor(f.timestamp / 1000)) : "?";
                return `${marker} ${WHITE}${fname}${RESET}  ${DIM}by ${shortenSig(f.uploader)} - ${when}${RESET}`;
            },
        );
        if (idx === null) return;
        const chosen = items[idx];
        if (chosen.kind === "back") return;

        const fname = chosen.file.ext
            ? `${chosen.file.name}.${chosen.file.ext}`
            : chosen.file.name;
        console.log();
        console.log(
            `  ${DIM}note: this came from a stranger (${shortenSig(chosen.file.uploader)}). scan it after download${RESET}`,
        );
        console.log(`  ${DIM}      if you're paranoid (you should be).${RESET}`);
        console.log();
        await downloadFlow(service, chosen.file.sig, speed, fname);
    }
};

// ── Download (shared by every download path) ───────────────────────────────
const downloadFlow = async (
    service: FileShareService,
    signature: string,
    speed: SpeedProfile,
    knownFilename?: string,
) => {
    const fallbackName = knownFilename && knownFilename.length > 0
        ? knownFilename
        : `${signature.slice(0, 16)}.bin`;
    const defaultDest = path.join(downloadsDir(), fallbackName);

    const dest = (await prompt(`save to [${defaultDest}]: `)).trim();
    const finalDest = dest ? expandPath(dest) : defaultDest;

    console.log();
    let result: {bytesWritten: number; filename: string};
    try {
        result = await service.downloadFile(signature, finalDest, speed, (pct) => {
            renderProgressBar(pct, "download");
        });
        renderProgressBar(100, "download");
    } catch (err) {
        finishProgressBar();
        logError("download failed", err);
        await prompt("Press Enter to continue...");
        return;
    }
    finishProgressBar();

    console.log();
    logSuccess(`saved ${formatBytes(result.bytesWritten)} -> ${finalDest}`);
    if (result.filename && path.basename(finalDest) !== result.filename) {
        console.log(`  ${DIM}on-chain filename: ${result.filename}${RESET}`);
    }
    await prompt("Press Enter to continue...");
};

const downloadBySignatureFlow = async (service: FileShareService, speed: SpeedProfile) => {
    console.clear();
    console.log(`${BOLD}${CYAN}download by signature${RESET}  ${DIM}(speed: ${speed})${RESET}`);
    console.log();

    const sig = (await prompt("tx signature: ")).trim();
    if (!sig) {
        logInfo("cancelled");
        return;
    }
    if (sig.length < 60) {
        logError("that doesn't look like a solana tx signature");
        await prompt("Press Enter to continue...");
        return;
    }

    // Peek metadata so we can pre-fill the destination filename. We do this
    // unconditionally for download-by-signature because the user has nothing
    // else to go on; for the My Files flow we already have the signature in
    // hand and let the user opt in to peek separately.
    logStep("fetching metadata...");
    let knownFilename = "";
    try {
        const {metadata} = await iqlabs.reader.readCodeIn(sig);
        const meta = JSON.parse(metadata);
        if (typeof meta?.filename === "string") knownFilename = meta.filename;
        const filetype = typeof meta?.filetype === "string" ? meta.filetype : "?";
        const chunks = typeof meta?.total_chunks === "number" ? meta.total_chunks : "?";
        console.log(`  ${DIM}filename:${RESET} ${knownFilename || "(unknown)"}`);
        console.log(`  ${DIM}filetype:${RESET} ${filetype}`);
        console.log(`  ${DIM}chunks:  ${RESET}${chunks}`);
        console.log();
    } catch (err) {
        logError("couldn't read metadata", err instanceof Error ? err.message : String(err));
        const cont = (await prompt("continue anyway? (y/N): ")).trim().toLowerCase();
        if (cont !== "y") return;
    }

    await downloadFlow(service, sig, speed, knownFilename);
};

// ── My Files (signature list — no metadata fetch) ───────────────────────────
//
// We deliberately do NOT fetch metadata for every entry here. Inventory can
// have hundreds of entries, and one readCodeIn per row is a real RPC bill.
// Inventory also mixes file uploads with system entries (DH keys, profile
// metadata, ...). Filtering them apart only by reading metadata is the naive
// way.
//
// TODO(global-file-share): better filter — used by the previous global file
// sharing feature in simple-sns — is to look at which transactions paid the
// fee receiver. Only "real" file uploads via codeIn route SOL to the IQ fee
// receiver, so scanning tx ix lists for transfers to that address gives you
// the file set without ever decoding metadata. Add this as a toggle later.
const myFilesFlow = async (service: FileShareService, speed: SpeedProfile) => {
    console.clear();
    console.log(`${BOLD}${CYAN}my files${RESET}  ${DIM}(inventory tx list)${RESET}`);
    console.log();

    const inventoryPda = iqlabs.contract.getUserInventoryPda(
        service.signer.publicKey,
        service.programId,
    );
    const info = await service.connection.getAccountInfo(inventoryPda);
    if (!info) {
        logInfo("inventory account is not initialized yet");
        await prompt("Press Enter to continue...");
        return;
    }

    logStep("fetching inventory signatures...");
    let sigs: Awaited<ReturnType<typeof service.connection.getSignaturesForAddress>>;
    try {
        sigs = await service.connection.getSignaturesForAddress(inventoryPda, {limit: 100});
    } catch (err) {
        logError("failed to fetch inventory", err);
        await prompt("Press Enter to continue...");
        return;
    }
    if (sigs.length === 0) {
        logInfo("no inventory items");
        await prompt("Press Enter to continue...");
        return;
    }

    while (true) {
        const items = sigs.map((s) => ({
            sig: s.signature,
            blockTime: s.blockTime ?? 0,
            err: s.err,
        }));

        const idx = await selectFromList(
            `${BOLD}${CYAN}my files${RESET} ${DIM}(${items.length} txs)${RESET}\n${DIM}metadata is not fetched up-front to keep RPC usage low${RESET}`,
            items,
            (item, selected) => {
                const marker = selected ? `${CYAN}>${RESET}` : " ";
                const sigShort = shortenSig(item.sig);
                const when = item.blockTime ? timeAgo(item.blockTime) : "?";
                const errTag = item.err ? ` ${RED}[err]${RESET}` : "";
                return `${marker} ${WHITE}${sigShort}${RESET}  ${DIM}${when}${RESET}${errTag}`;
            },
        );
        if (idx === null) return;

        const chosen = items[idx];
        const action = await pickAction(chosen.sig);
        if (action === null) continue;
        if (action === "back") continue;
        if (action === "peek") {
            await peekFlow(chosen.sig);
            continue;
        }
        if (action === "download") {
            // Peek first to get a sensible default filename, then download.
            let filename = "";
            try {
                const {metadata} = await iqlabs.reader.readCodeIn(chosen.sig);
                const meta = JSON.parse(metadata);
                if (typeof meta?.filename === "string") filename = meta.filename;
            } catch {
                // ok — fall back to <sig>.bin in downloadFlow
            }
            await downloadFlow(service, chosen.sig, speed, filename);
            continue;
        }
    }
};

const pickAction = async (sig: string): Promise<"peek" | "download" | "back" | null> => {
    const actions = [
        {label: "Download", value: "download" as const},
        {label: "Peek metadata", value: "peek" as const},
        {label: "Back", value: "back" as const},
    ];
    const idx = await selectFromList(
        `${DIM}tx: ${shortenSig(sig)}${RESET}`,
        actions,
        (item, selected) => {
            const marker = selected ? `${CYAN}>${RESET}` : " ";
            return `${marker} ${item.label}`;
        },
    );
    if (idx === null) return null;
    return actions[idx].value;
};

const peekFlow = async (sig: string) => {
    console.clear();
    console.log(`${BOLD}${CYAN}peek metadata${RESET}`);
    console.log(`${DIM}${sig}${RESET}`);
    console.log();
    try {
        const {metadata, data} = await iqlabs.reader.readCodeIn(sig);
        console.log(`${DIM}metadata:${RESET}`);
        console.log(`  ${truncate(metadata, 600)}`);
        if (data) {
            console.log();
            console.log(`${DIM}data preview:${RESET} ${truncate(data, 200)}`);
        }
    } catch (err) {
        logError("failed to peek", err instanceof Error ? err.message : String(err));
    }
    console.log();
    await prompt("Press Enter to continue...");
};

// ── Speed settings ──────────────────────────────────────────────────────────
const speedSettingsFlow = async (
    currentSpeed: SpeedProfile,
    defaultSpeed: SpeedProfile,
): Promise<SpeedProfile> => {
    type Choice = {label: string; value: SpeedProfile | "default"};
    const items: Choice[] = [
        {label: `Default (${defaultSpeed})`, value: "default"},
        ...SPEED_PROFILES.map((p) => ({label: p, value: p})),
    ];
    const idx = await selectFromList(
        `${BOLD}${CYAN}speed${RESET}  ${DIM}current: ${currentSpeed}${RESET}`,
        items,
        (item, selected) => {
            const marker = selected ? `${CYAN}>${RESET}` : " ";
            const isCurrent =
                item.value === currentSpeed
                || (item.value === "default" && currentSpeed === defaultSpeed);
            const tag = isCurrent ? ` ${GREEN}*${RESET}` : "";
            return `${marker} ${item.label}${tag}`;
        },
    );
    if (idx === null) return currentSpeed;
    const chosen = items[idx].value;
    const next = chosen === "default" ? defaultSpeed : chosen;
    if (next !== currentSpeed) {
        logInfo(`speed -> ${next}`);
        if (next !== "light") {
            console.log(
                `  ${YELLOW}warning:${RESET} non-light profiles need a high-tier RPC plan.`,
            );
            console.log(
                `           free/low-tier helius keys will hit 429 at ${next}.`,
            );
            console.log(
                `           if uploads start failing, switch back to light.`,
            );
        }
        await prompt("Press Enter to continue...");
    }
    return next;
};

// ── Top-level menu ──────────────────────────────────────────────────────────
const FILE_SHARE_LOGO = `${BOLD}${MAGENTA}
  ███████╗██╗██╗     ███████╗
  ██╔════╝██║██║     ██╔════╝
  █████╗  ██║██║     █████╗
  ██╔══╝  ██║██║     ██╔══╝
  ██║     ██║███████╗███████╗
  ╚═╝     ╚═╝╚══════╝╚══════╝${RESET}`;

const MENU_ITEMS = [
    {label: "Upload file",            action: "upload"},
    {label: "Browse IQ Plaza",        action: "browse-plaza"},
    {label: "My files",               action: "list"},
    {label: "Download by signature",  action: "download"},
    {label: "Speed settings",         action: "speed"},
    {label: "Back",                   action: null},
];

// Top-level upload entry — pick destination, then dispatch.
const uploadFlow = async (service: FileShareService, speed: SpeedProfile) => {
    console.clear();
    const dest = await pickUploadDestination();
    if (dest === null) return;
    if (dest === "inventory") {
        await uploadToInventoryFlow(service, speed);
    } else {
        await uploadToPlazaFlow(service, speed);
    }
};

export const runFileShareMenu = async () => {
    const service = new FileShareService();
    const defaultSpeed = computeDefaultSpeed();
    let currentSpeed: SpeedProfile = defaultSpeed;

    while (true) {
        const me = service.signer.publicKey.toBase58();
        const header = `${FILE_SHARE_LOGO}\n  ${DIM}wallet: ${GREEN}${shortenSig(me)}${RESET}  ${DIM}speed: ${RESET}${currentSpeed}`;

        const idx = await selectFromList(
            header,
            MENU_ITEMS,
            (item, selected) => {
                if (item.action === null) {
                    return selected
                        ? `  ${DIM}${CYAN}> ${WHITE}Back${RESET}`
                        : `  ${DIM}  Back${RESET}`;
                }
                return selected
                    ? `  ${BOLD}${CYAN}> ${WHITE}${item.label}${RESET}`
                    : `  ${DIM}  ${item.label}${RESET}`;
            },
        );

        if (idx === null || MENU_ITEMS[idx].action === null) break;

        try {
            switch (MENU_ITEMS[idx].action) {
                case "upload":
                    await uploadFlow(service, currentSpeed);
                    break;
                case "browse-plaza":
                    await browsePlazaFlow(service, currentSpeed);
                    break;
                case "list":
                    await myFilesFlow(service, currentSpeed);
                    break;
                case "download":
                    await downloadBySignatureFlow(service, currentSpeed);
                    break;
                case "speed":
                    currentSpeed = await speedSettingsFlow(currentSpeed, defaultSpeed);
                    break;
            }
        } catch (err) {
            logError("file sharing action failed", err);
            await prompt("Press Enter to continue...");
        }
    }
};
