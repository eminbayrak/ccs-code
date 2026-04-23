import { listPlugins } from "../src/migration/pluginLoader.js";
const plugins = await listPlugins(process.cwd());
console.log(JSON.stringify(plugins, null, 2));
