/**
 * migrate-table-seeds.ts
 * ---------------------------------------------------------------------------
 * Migrates DbRoot.table_seeds from hashed values to raw slug strings.
 *
 * Before: table_seeds = [keccak256("po"), keccak256("biz"), ...]
 * After:  table_seeds = [Buffer("po"), Buffer("biz"), ...]
 *
 * This allows anyone reading DbRoot to discover board slugs without
 * needing a hardcoded lookup table. PDA derivation still works by
 * hashing the slug via toSeedBytes() at read time.
 *
 * Requirements:
 *   - Signer must be the DbRoot creator
 *   - Uses update_db_root_table_list instruction
 *
 * Usage:
 *   DRY RUN (default):  npx tsx scripts/migrate-table-seeds.ts
 *   EXECUTE:            npx tsx scripts/migrate-table-seeds.ts --execute
 */

import {Connection, Keypair, PublicKey} from "@solana/web3.js";
import {BorshAccountsCoder, type Idl} from "@coral-xyz/anchor";
import {createRequire} from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import iqlabs from "@iqlabs-official/solana-sdk";
import {sendInstruction} from "../src/utils/tx";

const require2 = createRequire(import.meta.url);
const IDL = require2("@iqlabs-official/solana-sdk/idl/code_in.json") as Idl;

// ─── Config ─────────────────────────────────────────────────────────────────

const DB_ROOT_ID = "iqchan";

/** Onboarded board slugs (order will be preserved in the new table_seeds) */
const ONBOARDED_SLUGS = ["iq", "po", "biz", "a", "g"];

const execute = process.argv.includes("--execute");

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const connection = new Connection(iqlabs.getRpcUrl(), "confirmed");
    const programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
    const accountCoder = new BorshAccountsCoder(IDL);
    const signer = loadKeypair();

    console.log("Signer:", signer.publicKey.toBase58());
    console.log("Mode:", execute ? "🔴 EXECUTE" : "🟡 DRY RUN (add --execute to apply)");
    console.log("");

    // 1. Read current DbRoot
    const dbRootId = Buffer.from(iqlabs.utils.toSeedBytes(DB_ROOT_ID));
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);
    const info = await connection.getAccountInfo(dbRoot);
    if (!info) {
        console.error("DbRoot not found!");
        process.exit(1);
    }

    const decoded = accountCoder.decode("DbRoot", info.data) as {
        creator: PublicKey;
        table_seeds: Uint8Array[];
        global_table_seeds: Uint8Array[];
    };

    // 2. Verify signer is creator
    const creator = new PublicKey(decoded.creator);
    console.log("DbRoot creator:", creator.toBase58());
    if (!creator.equals(signer.publicKey)) {
        console.error("❌ Signer is NOT the DbRoot creator. Cannot migrate.");
        process.exit(1);
    }
    console.log("✓ Signer matches creator");
    console.log("");

    // 3. Show current state
    console.log("=== Current table_seeds (hashed) ===");
    for (const seed of decoded.table_seeds) {
        console.log(" ", Buffer.from(seed).toString("hex"));
    }
    console.log("");

    // 4. Verify each slug maps to a current seed
    console.log("=== Slug → Hash verification ===");
    const currentSeedSet = new Set(
        decoded.table_seeds.map(s => Buffer.from(s).toString("hex")),
    );

    for (const slug of ONBOARDED_SLUGS) {
        const hash = Buffer.from(iqlabs.utils.toSeedBytes(slug)).toString("hex");
        const found = currentSeedSet.has(hash);
        console.log(`  ${slug.padEnd(5)} → ${hash.slice(0, 16)}... ${found ? "✓ found" : "❌ NOT FOUND"}`);
        if (!found) {
            console.error(`\n❌ Slug "${slug}" hash not found in current table_seeds. Aborting.`);
            process.exit(1);
        }
    }

    if (decoded.table_seeds.length !== ONBOARDED_SLUGS.length) {
        console.warn(`\n⚠ table_seeds has ${decoded.table_seeds.length} entries but ONBOARDED_SLUGS has ${ONBOARDED_SLUGS.length}`);
        console.warn("  Extra on-chain seeds will be dropped! Verify this is intended.");
    }
    console.log("");

    // 5. Build new table_seeds (raw slug bytes)
    const newTableSeeds = ONBOARDED_SLUGS.map(slug => Buffer.from(slug, "utf8"));

    console.log("=== New table_seeds (raw slugs) ===");
    for (const seed of newTableSeeds) {
        console.log(`  "${seed.toString("utf8")}" (${seed.length} bytes) → hex: ${seed.toString("hex")}`);
    }
    console.log("");

    // 6. Verify PDA derivation: reading hint as string → toSeedBytes(string) → PDA must match original
    console.log("=== PDA verification ===");
    for (const slug of ONBOARDED_SLUGS) {
        const oldSeed = Buffer.from(iqlabs.utils.toSeedBytes(slug));
        const oldPda = iqlabs.contract.getTablePda(dbRoot, oldSeed, programId);
        // After migration: read hint as utf8 string, then toSeedBytes(string) hashes it
        const newPda = iqlabs.contract.getTablePda(dbRoot, iqlabs.utils.toSeedBytes(slug), programId);
        const match = oldPda.equals(newPda);
        console.log(`  ${slug.padEnd(5)} PDA: ${oldPda.toBase58().slice(0, 20)}... ${match ? "✓ match" : "❌ MISMATCH"}`);
        if (!match) {
            console.error(`\n❌ PDA mismatch for "${slug}". This would break table access!`);
            process.exit(1);
        }
    }
    console.log("");

    if (!execute) {
        console.log("🟡 DRY RUN complete. Run with --execute to apply migration.");
        return;
    }

    // 7. Execute migration
    console.log("🔴 Executing migration...");
    const builder = iqlabs.contract.createInstructionBuilder(IDL, programId);
    const ix = iqlabs.contract.updateDbRootTableListInstruction(builder, {
        db_root: dbRoot,
        signer: signer.publicKey,
    }, {
        db_root_id: dbRootId,
        new_table_seeds: newTableSeeds,
    });

    const signature = await sendInstruction(connection, signer, ix);
    console.log("✅ Migration complete!");
    console.log("Signature:", signature);

    // 8. Verify
    console.log("\n=== Post-migration verification ===");
    const newInfo = await connection.getAccountInfo(dbRoot);
    if (newInfo) {
        const newDecoded = accountCoder.decode("DbRoot", newInfo.data) as {
            table_seeds: Uint8Array[];
        };
        for (const seed of newDecoded.table_seeds) {
            const raw = Buffer.from(seed).toString("utf8");
            console.log(`  "${raw}" (${seed.length} bytes)`);
        }
    }
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
