/**
 * childenv.mjs - the environment a program started for a bot gets (SEC-12).
 *
 * The hub runs with its own secrets in the environment (ASSIST_PROXY_SECRET,
 * DESK_VNC_PASSWORD, a model key...) and the user may have more (GITHUB_TOKEN,
 * DB_PASSWORD). A command a bot runs, a coding assistant, or a connected app
 * gets none of them: the hub's own ASSIST_* / DESK_* settings and anything
 * named like a key, token, secret or password are taken out. PATH, HOME, LANG
 * and the rest stay, so programs still find what they need.
 *
 * `keep` puts back named variables a program needs to sign in (a coding
 * assistant that uses OPENAI_API_KEY instead of a subscription login).
 */

const HUB_OWN = /^(ASSIST_|DESK_)/i;
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i;

export function childEnv(source = process.env, { keep = [] } = {}) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (HUB_OWN.test(key) || SECRET_NAME.test(key)) delete env[key];
  }
  for (const key of keep) {
    if (!HUB_OWN.test(key) && source[key] !== undefined) env[key] = source[key];
  }
  return env;
}
