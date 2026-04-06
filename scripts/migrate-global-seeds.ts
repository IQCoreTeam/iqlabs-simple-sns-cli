/**
 * migrate-global-seeds.ts
 * ---------------------------------------------------------------------------
 * Migrates DbRoot.global_table_seeds from hashed values to raw hint strings.
 * Hints were resolved from each Table account's name field.
 *
 * Usage:
 *   DRY RUN:   npx tsx scripts/migrate-global-seeds.ts
 *   EXECUTE:   npx tsx scripts/migrate-global-seeds.ts --execute
 */

import {Connection, Keypair, PublicKey} from "@solana/web3.js";
import {BorshAccountsCoder, type Idl} from "@coral-xyz/anchor";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import iqlabs from "@iqlabs-official/solana-sdk";
import {sendInstruction} from "../src/utils/tx";

const IDL_PATH = path.join(process.cwd(), "node_modules/@iqlabs-official/solana-sdk/idl/code_in.json");
const IDL = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;

const DB_ROOT_ID = "iqchan";
const execute = process.argv.includes("--execute");

/**
 * Active boards + threads only.
 * Removed: 11 old-format threads (boards/po/threads/...), 3 empty test tables,
 * 10 never-active threads (last_timestamp = 0).
 */
const GLOBAL_HINTS = [
    // Active threads
    "biz/thread/7e3fb0c6-5681-4fe2-a086-3e40b422adc9",
    "biz/thread/f313587d-595e-4a26-a5af-36e709925499",
    "biz/thread/c7edb944-b3d3-4d6f-bfc5-694e15a4e970",
    "g/thread/4428fbec-8758-4c7f-9234-c205ad7ed05c",
    "biz/thread/73df4d7c-b262-47b6-b14c-72630a32edf3",
    "po/thread/e87b31c8-f4e8-4d00-a693-e324164ad8cc",
    "po/thread/3ac66348-4cee-4669-b333-1dacfe97f7da",
    "g/thread/01fe39da-3b25-435c-9ef7-dc0f4163b4a1",
    "po/thread/42d1cf78-9c1d-4881-b1c9-730911d4bcd7",
    "g/thread/1a8c2245-643b-4ac0-a61e-3d32fed107d0",
    "po/thread/b9dca26c-110c-4ae2-8cef-5160a14510f9",
    "iq/thread/0139063d-1649-482b-9eca-15bef74948fc",
    "biz/thread/90e797af-d425-4546-a00d-ab1bc72feb44",
    // Boards
    "po", "biz", "a", "g", "iq",
    "nub", "mlg", "y2k", "retardio", "dominance",
];

function loadKeypair(): Keypair {
    const deployPath = path.join(os.homedir(), "Desktop", "deploy.json");
    const localPath = path.join(process.cwd(), "keypair.json");
    const defaultPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const kpPath = fs.existsSync(deployPath) ? deployPath
        : fs.existsSync(localPath) ? localPath : defaultPath;
    console.log("Keypair:", kpPath);
    const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
    const connection = new Connection(iqlabs.getRpcUrl(), "confirmed");
    const programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
    const accountCoder = new BorshAccountsCoder(IDL);
    const signer = loadKeypair();

    console.log("Signer:", signer.publicKey.toBase58());
    console.log("Mode:", execute ? "🔴 EXECUTE" : "🟡 DRY RUN (add --execute to apply)");
    console.log("");

    const dbRootId = Buffer.from(iqlabs.utils.toSeedBytes(DB_ROOT_ID));
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);
    const info = await connection.getAccountInfo(dbRoot);
    if (!info) { console.error("DbRoot not found!"); process.exit(1); }

    const decoded = accountCoder.decode("DbRoot", info.data) as {
        creator: any;
        global_table_seeds: Uint8Array[];
    };

    const creator = new PublicKey(decoded.creator);
    if (!creator.equals(signer.publicKey)) {
        console.error("❌ Signer is NOT the DbRoot creator.");
        process.exit(1);
    }
    console.log("✓ Signer matches creator");

    console.log(`On-chain global_table_seeds: ${decoded.global_table_seeds.length} entries`);
    console.log(`New global_table_seeds: ${GLOBAL_HINTS.length} entries (cleaned up)\n`);

    // Verify each hint exists on-chain by checking its hash against current seeds
    const onChainSet = new Set(
        decoded.global_table_seeds.map((s: Uint8Array) => Buffer.from(s).toString("hex")),
    );

    console.log("=== Verification ===");
    for (const hint of GLOBAL_HINTS) {
        const hash = Buffer.from(iqlabs.utils.toSeedBytes(hint)).toString("hex");
        if (!onChainSet.has(hash)) {
            console.error(`❌ "${hint}" not found on-chain! Aborting.`);
            process.exit(1);
        }
    }
    console.log(`✓ All ${GLOBAL_HINTS.length} hints verified (exist on-chain)`);

    const newGlobalSeeds = GLOBAL_HINTS.map(h => Buffer.from(h, "utf8"));
    console.log(`\nNew global_table_seeds: ${newGlobalSeeds.length} entries (total ${newGlobalSeeds.reduce((s, b) => s + b.length, 0)} bytes)`);

    if (!execute) {
        console.log("\n🟡 DRY RUN complete. Run with --execute to apply.");
        return;
    }

    console.log("\n🔴 Executing migration...");
    const builder = iqlabs.contract.createInstructionBuilder(IDL, programId);

    // Use builder.build directly since updateDbRootGlobalTableListInstruction may not be in installed SDK
    const ix = builder.build("update_db_root_global_table_list", {
        db_root: dbRoot,
        signer: signer.publicKey,
    }, {
        db_root_id: dbRootId,
        new_global_table_seeds: newGlobalSeeds,
    });

    const signature = await sendInstruction(connection, signer, ix);
    console.log("✅ Migration complete!");
    console.log("Signature:", signature);

    // Verify
    console.log("\n=== Post-migration verification ===");
    const newInfo = await connection.getAccountInfo(dbRoot);
    if (newInfo) {
        const newDecoded = accountCoder.decode("DbRoot", newInfo.data) as {
            global_table_seeds: Uint8Array[];
        };
        for (const seed of newDecoded.global_table_seeds.slice(0, 10)) {
            console.log(`  "${Buffer.from(seed).toString("utf8")}"`);
        }
        if (newDecoded.global_table_seeds.length > 10) {
            console.log(`  ... and ${newDecoded.global_table_seeds.length - 10} more`);
        }
    }
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
