import * as readline from "node:readline";

let rl: readline.Interface | null = null;

export const getReadline = () => {
    if (!rl) {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
    }
    return rl;
};

export const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => getReadline().question(question, resolve));

export const closeReadline = () => {
    if (rl) {
        rl.close();
        rl = null;
    }
};

export const selectFromList = async (
    title: string,
    items: any[],
    render: (item: any, selected: boolean) => string,
): Promise<number | null> => {
    if (items.length === 0) {
        return null;
    }
    if (!process.stdin.isTTY) {
        console.clear();
        console.log(title);
        items.forEach((item, index) => {
            console.log(`  ${index + 1}) ${render(item, false)}`);
        });
        const input = (await prompt("Select: ")).trim();
        const choice = Number.parseInt(input, 10);
        if (!choice || choice < 1 || choice > items.length) {
            return null;
        }
        return choice - 1;
    }

    closeReadline();
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    let index = 0;
    const draw = () => {
        console.clear();
        console.log(title);
        console.log("");
        items.forEach((item, i) => {
            console.log(render(item, i === index));
        });
        console.log("");
        console.log("\x1b[2m  Enter = select  |  Esc = back\x1b[0m");
    };

    return await new Promise<number | null>((resolve) => {
        const onKey = (_: string, key: readline.Key) => {
            if (key.name === "up") {
                index = (index - 1 + items.length) % items.length;
                draw();
                return;
            }
            if (key.name === "down") {
                index = (index + 1) % items.length;
                draw();
                return;
            }
            if (key.name === "return") {
                cleanup();
                resolve(index);
                return;
            }
            if (key.name === "escape" || key.sequence === "\x1b" || (key.ctrl && key.name === "c")) {
                cleanup();
                resolve(null);
            }
        };

        const cleanup = () => {
            stdin.off("keypress", onKey);
            stdin.setRawMode(Boolean(wasRaw));
            stdin.pause();
            rl = null;
        };

        stdin.on("keypress", onKey);
        draw();
    });
};
