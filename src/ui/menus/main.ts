import {getWalletCtx, getKeypairInfo} from "../../utils/wallet_manager";
import {logError, RESET, BOLD, DIM, CYAN, GREEN} from "../../utils/logger";
import {prompt} from "../../utils/prompt";
import {shortenSig} from "../../utils/format";
import {runChatCommand} from "./chat";
import {runMyMenu} from "./my-menu";
import {runIqchanMenu} from "./iqchan";

const showMainMenu = () => {
    const {signer} = getWalletCtx();
    const pubkey = signer.publicKey.toBase58();
    const {path: kpPath} = getKeypairInfo();

    console.log("");
    console.log(`  ${BOLD}${CYAN}╔══════════════════════════╗${RESET}`);
    console.log(`  ${BOLD}${CYAN}║   Solana Internet CLI    ║${RESET}`);
    console.log(`  ${BOLD}${CYAN}╚══════════════════════════╝${RESET}`);
    console.log(`  ${DIM}Wallet: ${GREEN}${shortenSig(pubkey, 6)}${RESET}`);
    console.log(`  ${DIM}Key:    ${kpPath}${RESET}`);
    console.log("");
    console.log(`  ${BOLD}1${RESET}) My Menu`);
    console.log(`  ${BOLD}2${RESET}) SolChat`);
    console.log(`  ${BOLD}3${RESET}) IQChan`);
    console.log("");
    console.log(`  ${DIM}0) Exit${RESET}`);
    console.log("");
};

export const runMainMenu = async () => {
    let running = true;
    while (running) {
        console.clear();
        showMainMenu();
        const choice = (await prompt("Select: ")).trim();
        try {
            switch (choice) {
                case "1":
                    await runMyMenu();
                    break;
                case "2":
                    await runChatCommand();
                    break;
                case "3":
                    await runIqchanMenu();
                    break;
                case "0":
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
