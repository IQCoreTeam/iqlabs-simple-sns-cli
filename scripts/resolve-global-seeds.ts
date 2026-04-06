/**
 * For each global_table_seed in iqchan DbRoot, try to read the Table account's name field.
 * Also check if it matches any known slug by hashing known values.
 */
import {Connection, PublicKey} from "@solana/web3.js";
import {BorshAccountsCoder, type Idl} from "@coral-xyz/anchor";
import {createRequire} from "node:module";
import iqlabs from "@iqlabs-official/solana-sdk";

const require2 = createRequire(import.meta.url);
const IDL = require2("@iqlabs-official/solana-sdk/idl/code_in.json") as Idl;

const KNOWN_SLUGS = ["iq", "po", "biz", "a", "g", "nub", "mlg", "y2k", "retardio", "dominance"];

async function main() {
    const connection = new Connection(iqlabs.getRpcUrl(), "confirmed");
    const programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
    const accountCoder = new BorshAccountsCoder(IDL);
    const dbRootId = Buffer.from(iqlabs.utils.toSeedBytes("iqchan"));
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);
    const info = await connection.getAccountInfo(dbRoot);
    if (!info) { console.error("DbRoot not found"); process.exit(1); }

    const decoded = accountCoder.decode("DbRoot", info.data) as {
        global_table_seeds: Uint8Array[];
    };

    // Build reverse lookup: hash → slug
    const hashToSlug = new Map<string, string>();
    for (const slug of KNOWN_SLUGS) {
        const hash = Buffer.from(iqlabs.utils.toSeedBytes(slug)).toString("hex");
        hashToSlug.set(hash, slug);
    }

    console.log(`global_table_seeds: ${decoded.global_table_seeds.length} entries\n`);

    const results: Array<{index: number, seedHex: string, hint: string}> = [];

    for (let i = 0; i < decoded.global_table_seeds.length; i++) {
        const seed = decoded.global_table_seeds[i];
        const seedHex = Buffer.from(seed).toString("hex");

        // Check known slug
        const knownSlug = hashToSlug.get(seedHex);
        if (knownSlug) {
            results.push({index: i, seedHex, hint: knownSlug});
            console.log(`[${i}] BOARD: "${knownSlug}"`);
            continue;
        }

        // Rate limit: wait between RPC calls
        await new Promise(r => setTimeout(r, 200));

        // Try to read Table account
        const tablePda = iqlabs.contract.getTablePda(dbRoot, seed, programId);
        let tableName = "(table not found)";
        try {
            const tableInfo = await connection.getAccountInfo(tablePda);
            if (tableInfo) {
                const dec = accountCoder.decode("Table", tableInfo.data) as { name: Uint8Array };
                tableName = Buffer.from(dec.name).toString("utf8").replace(/\0+$/, "").trim();
            }
        } catch {
            tableName = "(fetch failed)";
        }

        results.push({index: i, seedHex, hint: tableName});
        console.log(`[${i}] table_name: "${tableName}"`);
    }

    // Output as JSON for migration script
    console.log("\n=== Migration data (JSON) ===");
    console.log(JSON.stringify(results.map(r => r.hint), null, 2));
}

main().catch(console.error);
