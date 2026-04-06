import {Connection, PublicKey} from "@solana/web3.js";
import {BorshAccountsCoder, type Idl} from "@coral-xyz/anchor";
import {createHash} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import iqlabs from "@iqlabs-official/solana-sdk";

const IDL_PATH = path.join(process.cwd(), "node_modules/@iqlabs-official/solana-sdk/idl/code_in.json");
const IDL = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;

function sha256(s: string): Buffer { return createHash("sha256").update(s).digest(); }

async function main() {
    const connection = new Connection(iqlabs.getRpcUrl(), "confirmed");
    const programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
    const accountCoder = new BorshAccountsCoder(IDL);
    const dbRootId = sha256("clawbal-iqlabs");
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);
    const info = await connection.getAccountInfo(dbRoot);
    if (!info) { console.error("DbRoot not found"); process.exit(1); }

    const decoded = accountCoder.decode("DbRoot", info.data) as {
        creator: any;
        table_seeds: Uint8Array[];
        global_table_seeds: Uint8Array[];
    };

    console.log("Creator:", new PublicKey(decoded.creator).toBase58());
    console.log(`table_seeds: ${decoded.table_seeds.length}`);
    console.log(`global_table_seeds: ${decoded.global_table_seeds.length}\n`);

    // Resolve table_seeds
    console.log("=== table_seeds ===");
    for (let i = 0; i < decoded.table_seeds.length; i++) {
        const seed = decoded.table_seeds[i];
        const seedHex = Buffer.from(seed).toString("hex");

        await new Promise(r => setTimeout(r, 250));

        const tablePda = iqlabs.contract.getTablePda(dbRoot, seed, programId);
        let tableName = "(not found)";
        try {
            const tableInfo = await connection.getAccountInfo(tablePda);
            if (tableInfo) {
                const dec = accountCoder.decode("Table", tableInfo.data) as { name: Uint8Array };
                tableName = Buffer.from(dec.name).toString("utf8").replace(/\0+$/, "").trim();
            }
        } catch { tableName = "(error)"; }

        // Verify: sha256(tableName) == seed?
        const verifyHash = sha256(tableName).toString("hex");
        const match = verifyHash === seedHex;

        console.log(`[${i}] "${tableName}" ${match ? "✓" : "✗ mismatch"}`);
    }

    // Resolve global_table_seeds
    console.log("\n=== global_table_seeds ===");
    for (let i = 0; i < decoded.global_table_seeds.length; i++) {
        const seed = decoded.global_table_seeds[i];
        const seedHex = Buffer.from(seed).toString("hex");

        await new Promise(r => setTimeout(r, 250));

        const tablePda = iqlabs.contract.getTablePda(dbRoot, seed, programId);
        let tableName = "(not found)";
        try {
            const tableInfo = await connection.getAccountInfo(tablePda);
            if (tableInfo) {
                const dec = accountCoder.decode("Table", tableInfo.data) as { name: Uint8Array };
                tableName = Buffer.from(dec.name).toString("utf8").replace(/\0+$/, "").trim();
            }
        } catch { tableName = "(error)"; }

        const verifyHash = sha256(tableName).toString("hex");
        const match = verifyHash === seedHex;

        console.log(`[${i}] "${tableName}" ${match ? "✓" : "✗ mismatch"}`);
    }
}

main().catch(console.error);
