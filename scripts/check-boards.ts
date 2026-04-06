import {Connection, PublicKey} from "@solana/web3.js";
import {BorshAccountsCoder, type Idl} from "@coral-xyz/anchor";
import {createRequire} from "node:module";
import iqlabs from "@iqlabs-official/solana-sdk";

const require = createRequire(import.meta.url);
const IDL = require("@iqlabs-official/solana-sdk/idl/code_in.json") as Idl;

const DB_ROOT_ID = "iqchan";
const dbRootId = Buffer.from(iqlabs.utils.toSeedBytes(DB_ROOT_ID));

async function main() {
    const connection = new Connection(iqlabs.getRpcUrl(), "confirmed");
    const programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
    const accountCoder = new BorshAccountsCoder(IDL);
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);

    const list = await iqlabs.reader.getTablelistFromRoot(connection, dbRootId) as any;
    const seeds = list.tableSeeds as string[];

    console.log("=== raw tableSeeds ===");
    console.log("type:", typeof seeds[0]);
    console.log("count:", seeds.length);
    console.log("first 3 raw:", seeds.slice(0, 3));
    console.log("");

    for (const seedHex of seeds) {
        const seed = Buffer.from(seedHex, "hex");
        const table = iqlabs.contract.getTablePda(dbRoot, seed, programId);
        const info = await connection.getAccountInfo(table);

        let tableName = "(could not decode)";
        if (info) {
            try {
                const decoded = accountCoder.decode("Table", info.data) as { name: Uint8Array };
                tableName = Buffer.from(decoded.name).toString("utf8").replace(/\0+$/, "").trim();
            } catch {}
        }

        console.log(`  seed: ${seedHex}`);
        console.log(`  table name: ${tableName}`);
        console.log(`  raw seed as utf8: ${seed.toString("utf8")}`);
        console.log("");
    }
}

main().catch(console.error);
