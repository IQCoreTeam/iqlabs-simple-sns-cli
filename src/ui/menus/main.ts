import {getWalletCtx} from "../../utils/wallet_manager";
import {logError, RESET, BOLD, DIM, CYAN, GREEN, WHITE, YELLOW} from "../../utils/logger";
import {prompt, selectFromList} from "../../utils/prompt";
import {shortenSig} from "../../utils/format";
import {runChatCommand} from "./chat";
import {runFileShareMenu} from "./file-share";
import {runMyMenu} from "./my-menu";
import {runIqchanMenu} from "./iqchan";

const LOGO = `${BOLD}${CYAN}
  ██╗ ██████╗ ██╗      █████╗ ██████╗ ███████╗
  ██║██╔═══██╗██║     ██╔══██╗██╔══██╗██╔════╝
  ██║██║   ██║██║     ███████║██████╔╝███████╗
  ██║██║▄▄ ██║██║     ██╔══██║██╔══██╗╚════██║
  ██║╚██████╔╝███████╗██║  ██║██████╔╝███████║
  ╚═╝ ╚══▀▀═╝ ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝${RESET}
`;

const MENU_ITEMS = [
    {label: "SolChat", action: runChatCommand},
    {label: "IQChan", action: runIqchanMenu},
    {label: "File Sharing", action: runFileShareMenu},
    {label: "My Menu", action: runMyMenu},
    {label: "Exit", action: null},
];

export const runMainMenu = async () => {
    const {signer} = getWalletCtx();
    const pubkey = shortenSig(signer.publicKey.toBase58());

    while (true) {
        const index = await selectFromList(
            `${LOGO}${DIM}  Wallet: ${GREEN}${pubkey}${RESET}`,
            MENU_ITEMS,
            (item, selected) => {
                if (item.action === null) {
                    return selected
                        ? `  ${DIM}${CYAN}> ${WHITE}Exit${RESET}`
                        : `  ${DIM}  Exit${RESET}`;
                }
                return selected
                    ? `  ${BOLD}${CYAN}> ${WHITE}${item.label}${RESET}`
                    : `  ${DIM}  ${item.label}${RESET}`;
            },
        );

        if (index === null || MENU_ITEMS[index].action === null) break;

        try {
            await MENU_ITEMS[index].action!();
        } catch (err) {
            logError("Error", err);
            await prompt("Press Enter to continue...");
        }
    }
};
