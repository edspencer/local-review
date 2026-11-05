// `--data-dir <path>`: the same as LOCAL_REVIEW_HOME, for one command. config.ts reads LOCAL_REVIEW_HOME as it loads,
// so this has to set it first: cli.ts imports this module before anything else, and ES modules run in import order.
// It only sets the variable; cli.ts's parseArgs checks the option like any other (a missing or empty value is a usage
// error there). A `service install` run with it carries it into the service, as it does LOCAL_REVIEW_HOME.
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const v = a === '--data-dir' ? argv[i + 1] : a.startsWith('--data-dir=') ? a.slice('--data-dir='.length) : undefined;
  if (v) process.env.LOCAL_REVIEW_HOME = v;
  if (a === '--data-dir') i++;
}

export {};
