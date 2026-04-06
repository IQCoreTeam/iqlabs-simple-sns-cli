import {Connection, PublicKey} from "@solana/web3.js";
import {BorshAccountsCoder, type Idl} from "@coral-xyz/anchor";
import * as fs from "node:fs";
import * as path from "node:path";
import iqlabs from "@iqlabs-official/solana-sdk";

const IDL_PATH = path.join(process.cwd(), "node_modules/@iqlabs-official/solana-sdk/idl/code_in.json");
const IDL = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;

const THREADS = [
    "biz/thread/7e3fb0c6-5681-4fe2-a086-3e40b422adc9",
    "biz/thread/f313587d-595e-4a26-a5af-36e709925499",
    "biz/thread/26d55575-8dbf-420f-acc2-92de8a893c91",
    "biz/thread/c7edb944-b3d3-4d6f-bfc5-694e15a4e970",
    "g/thread/4428fbec-8758-4c7f-9234-c205ad7ed05c",
    "biz/thread/c5594958-0be1-4d75-a947-8891e0da58e1",
    "biz/thread/73df4d7c-b262-47b6-b14c-72630a32edf3",
    "po/thread/e87b31c8-f4e8-4d00-a693-e324164ad8cc",
    "g/thread/356cea78-6e70-4535-87f6-48042ab6a763",
    "po/thread/3ac66348-4cee-4669-b333-1dacfe97f7da",
    "g/thread/01fe39da-3b25-435c-9ef7-dc0f4163b4a1",
    "po/thread/42d1cf78-9c1d-4881-b1c9-730911d4bcd7",
    "g/thread/1a8c2245-643b-4ac0-a61e-3d32fed107d0",
    "po/thread/e5b51a5f-13ad-4bb5-aff4-6a57d31d6540",
    "po/thread/b9dca26c-110c-4ae2-8cef-5160a14510f9",
    "iq/thread/0139063d-1649-482b-9eca-15bef74948fc",
    "iq/thread/99517061-4896-4558-8254-5fc80996d4dc",
    "iq/thread/84ed7e71-9c94-44a8-bceb-5ad2d779f291",
    "iq/thread/4e81538e-6ee7-4142-aa27-bf836fabd9ac",
    "iq/thread/5b226faa-27c7-44ea-bb20-e4e77724f60f",
    "po/thread/fdabf2ee-8225-4bd5-9adf-be5c4be66677",
    "g/thread/3b1a1955-df69-4482-8460-2fa418566bc4",
    "biz/thread/90e797af-d425-4546-a00d-ab1bc72feb44",
];

async function main() {
    const connection = new Connection(iqlabs.getRpcUrl(), "confirmed");
    const programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
    const accountCoder = new BorshAccountsCoder(IDL);
    const dbRootId = Buffer.from(iqlabs.utils.toSeedBytes("iqchan"));
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);

    console.log("Thread activity check:\n");

    for (const name of THREADS) {
        const seed = Buffer.from(iqlabs.utils.toSeedBytes(name));
        const tablePda = iqlabs.contract.getTablePda(dbRoot, seed, programId);

        await new Promise(r => setTimeout(r, 250));

        try {
            const tableInfo = await connection.getAccountInfo(tablePda);
            if (!tableInfo) {
                console.log(`  ${name.padEnd(55)} NO ACCOUNT`);
                continue;
            }
            const table = accountCoder.decode("Table", tableInfo.data) as { last_timestamp: bigint | number };
            const ts = Number(table.last_timestamp);
            const date = ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : "never";
            console.log(`  ${name.padEnd(55)} last: ${date}`);
        } catch (e) {
            console.log(`  ${name.padEnd(55)} ERROR`);
        }
    }
}

main().catch(console.error);
