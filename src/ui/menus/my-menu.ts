import * as fs from "node:fs";
import * as path from "node:path";
import iqlabs from "@iqlabs-official/solana-sdk";

import {ChatService} from "../../apps/chat/chat-service";
import {getWalletCtx} from "../../utils/wallet_manager";
import {logError, logInfo, logWarn, RESET, BOLD, DIM, CYAN, GREEN} from "../../utils/logger";
import {prompt} from "../../utils/prompt";
import {openFriendList} from "./chat";

const showMenu = () => {
    const {signer} = getWalletCtx();
    const pubkey = signer.publicKey.toBase58();
    console.log("");
    console.log(`  ${BOLD}${CYAN}╔══════════════════════════╗${RESET}`);
    console.log(`  ${BOLD}${CYAN}║        My Menu           ║${RESET}`);
    console.log(`  ${BOLD}${CYAN}╚══════════════════════════╝${RESET}`);
    console.log(`  ${DIM}Wallet: ${GREEN}${pubkey}${RESET}`);
    console.log("");
    console.log(`  ${BOLD}1${RESET}) RPC Settings`);
    console.log(`  ${BOLD}2${RESET}) My Profile`);
    console.log(`  ${BOLD}3${RESET}) My Inventory`);
    console.log(`  ${BOLD}4${RESET}) DM Inbox`);
    console.log("");
    console.log(`  ${DIM}9) Back${RESET}`);
    console.log("");
};

const ENV_PATH = path.join(process.cwd(), ".env");

const saveRpcToEnv = (url: string) => {
    let content = "";
    if (fs.existsSync(ENV_PATH)) {
        content = fs.readFileSync(ENV_PATH, "utf8");
    }
    const key = "SOLANA_RPC_ENDPOINT";
    const line = `${key}=${url}`;
    if (content.includes(key)) {
        content = content.replace(new RegExp(`^${key}=.*$`, "m"), line);
    } else {
        content = content.trimEnd() + (content ? "\n" : "") + line + "\n";
    }
    fs.writeFileSync(ENV_PATH, content, "utf8");
};

const rpcSettings = async () => {
    const current = iqlabs.getRpcUrl();
    logInfo(`Current RPC: ${current}`);
    console.log("");
    console.log("Paste your RPC endpoint URL below (empty to keep current):");
    const newUrl = (await prompt("> ")).trim();
    if (newUrl) {
        iqlabs.setRpcUrl(newUrl);
        saveRpcToEnv(newUrl);
        logInfo(`RPC updated and saved: ${newUrl}`);
    }
    await prompt("Press Enter to continue...");
};

const showProfile = async () => {
    const {signer} = getWalletCtx();
    const pubkey = signer.publicKey.toBase58();
    logInfo(`Public Key: ${pubkey}`);

    try {
        const state = await iqlabs.reader.readUserState(pubkey);
        logInfo("User State:", state);
    } catch {
        logInfo("No user state found on-chain");
    }
    await prompt("Press Enter to continue...");
};

const showInventory = async () => {
    const {connection, signer} = getWalletCtx();
    const pubkey = signer.publicKey;
    const inventoryPda = iqlabs.contract.getUserInventoryPda(pubkey);
    logInfo(`Inventory PDA: ${inventoryPda.toBase58()}`);

    const info = await connection.getAccountInfo(inventoryPda);
    if (info) {
        logInfo(`Account exists, data length: ${info.data.length} bytes`);
        logInfo(`Lamports: ${info.lamports}`);
    } else {
        logInfo("Inventory account not initialized");
    }
    await prompt("Press Enter to continue...");
};

const dmInbox = async () => {
    const service = new ChatService();
    try {
        await service.setupCliDemo();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Insufficient SOL")) {
            const {signer} = getWalletCtx();
            logError("Insufficient SOL balance — your wallet has 0 SOL.");
            logWarn(`Please fund this wallet to continue:`);
            console.log(`\n  ${CYAN}${signer.publicKey.toBase58()}${RESET}\n`);
        } else {
            logError("Chat setup failed", err);
        }
        await prompt("Press Enter to continue...");
        return;
    }
    await openFriendList(service);
};

export const runMyMenu = async () => {
    let running = true;
    while (running) {
        console.clear();
        showMenu();
        const choice = (await prompt("Select: ")).trim();
        try {
            switch (choice) {
                case "1":
                    await rpcSettings();
                    break;
                case "2":
                    await showProfile();
                    break;
                case "3":
                    await showInventory();
                    break;
                case "4":
                    await dmInbox();
                    break;
                case "9":
                    running = false;
                    break;
                default:
                    logError("Invalid option");
                    await prompt("Press Enter to continue...");
            }
        } catch (err) {
            logError("Error", err);
            await prompt("Press Enter to continue...");
        }
    }
};
