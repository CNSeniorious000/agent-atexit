const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version?: string };
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag || tag !== `v${manifest.version}`) throw new Error(`release tag ${tag ?? "<missing>"} must equal v${manifest.version}`);
