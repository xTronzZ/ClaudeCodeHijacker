const fs = require('node:fs/promises');
const path = require('node:path');

function parseEnv(text) {
  const values = {};
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Invalid .env entry on line ${index + 1}.`);
    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid .env variable name on line ${index + 1}.`);
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (!value.endsWith(quote) || value.length < 2) throw new Error(`Unterminated .env value on line ${index + 1}.`);
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(n|r|t|"|\\)/g, (_, escaped) => ({
        n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\',
      })[escaped]);
    } else {
      const comment = value.search(/\s+#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    values[name] = value;
  }
  return values;
}

function selectApiKey(values) {
  return values.CLAUDE_RELAY_API_KEY || values.ANTHROPIC_API_KEY || null;
}

async function loadApiKey({ env = process.env, envPath = path.join(__dirname, '..', '.env'), readFile = fs.readFile } = {}) {
  const processKey = selectApiKey(env);
  if (processKey) return { apiKey: processKey.trim(), source: 'environment' };
  let contents;
  try {
    contents = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const fileKey = selectApiKey(parseEnv(contents));
  return fileKey ? { apiKey: fileKey.trim(), source: envPath } : null;
}

module.exports = { parseEnv, loadApiKey };
