import {Connection, PublicKey} from "@solana/web3.js";
import {BorshAccountsCoder, type Idl} from "@coral-xyz/anchor";
import {createRequire} from "node:module";
import iqlabs from "@iqlabs-official/solana-sdk";

const require2 = createRequire(import.meta.url);
const IDL = require2("@iqlabs-official/solana-sdk/idl/code_in.json") as Idl;

const INDEX = parseInt(process.argv[2] ?? "36");

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
    const seed = decoded.global_table_seeds[INDEX];
    const seedHex = Buffer.from(seed).toString("hex");
    const tablePda = iqlabs.contract.getTablePda(dbRoot, seed, programId);

    console.log(`Index: ${INDEX}`);
    console.log(`Seed hex: ${seedHex}`);
    console.log(`Table PDA: ${tablePda.toBase58()}`);

    const tableInfo = await connection.getAccountInfo(tablePda);
    if (tableInfo) {
        const table = accountCoder.decode("Table", tableInfo.data) as {
            name: Uint8Array;
            column_names: Uint8Array[];
            id_col: Uint8Array;
        };
        console.log(`Table name: "${Buffer.from(table.name).toString("utf8").replace(/\0+$/, "")}"`);
        console.log(`Columns: ${table.column_names.map(c => Buffer.from(c).toString("utf8").replace(/\0+$/, ""))}`);
        console.log(`ID col: "${Buffer.from(table.id_col).toString("utf8").replace(/\0+$/, "")}"`);
    }

    console.log("\nRows (limit 5):");
    try {
        const rows = await iqlabs.reader.readTableRows(tablePda, {limit: 5});
        for (const row of rows) {
            console.log(JSON.stringify(row));
        }
        if (rows.length === 0) console.log("(empty)");
    } catch (e) {
        console.log("(failed to read rows)", e instanceof Error ? e.message : e);
    }
}

main().catch(console.error);
