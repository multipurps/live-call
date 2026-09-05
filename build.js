// Regenerates the served files (app.js, boot.js, index.html, styles.css,
// admin.html) from their readable .src. counterparts, minified and with
// comments/variable names stripped so the served bundle doesn't read like
// documentation of the app's architecture and provider choices to anyone
// who loads the URL or views source. Run `npm run build` after editing any
// *.src.* file - the .src. files are what should be edited and reviewed;
// the plain-named files are generated output and get overwritten every run.
const fs = require('fs');
const { minify } = require('terser');
const CleanCSS = require('clean-css');
const { minify: minifyHtml } = require('html-minifier-terser');

const JS_OPTS = {
  compress: { drop_console: false },
  // Mangle only local names (variables/function params/declarations) - this
  // never touches string literals, so every $('someId') DOM lookup (which
  // matches elements by their literal id attribute, not by JS identifier)
  // keeps working exactly as before. Top-level names are left alone too,
  // since this app has no bundler and some names may be relied on across
  // files loaded as separate <script>/module tags.
  mangle: { toplevel: false },
  format: { comments: false },
};

async function buildJs(srcPath, outPath){
  const code = fs.readFileSync(srcPath, 'utf8');
  const result = await minify(code, JS_OPTS);
  if (result.error) throw result.error;
  fs.writeFileSync(outPath, result.code);
  console.log(`${outPath}: ${code.length} -> ${result.code.length} bytes`);
}

function buildCss(srcPath, outPath){
  const code = fs.readFileSync(srcPath, 'utf8');
  const result = new CleanCSS({ level: 2 }).minify(code);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  fs.writeFileSync(outPath, result.styles);
  console.log(`${outPath}: ${code.length} -> ${result.styles.length} bytes`);
}

async function buildHtml(srcPath, outPath){
  const code = fs.readFileSync(srcPath, 'utf8');
  const result = await minifyHtml(code, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    // Inline <script type="module"> bodies get run through the same JS
    // minifier/mangler as the standalone files, for the same reason.
    minifyJS: (text) => minify(text, JS_OPTS).then((r) => r.code || text).catch(() => text),
  });
  fs.writeFileSync(outPath, result);
  console.log(`${outPath}: ${code.length} -> ${result.length} bytes`);
}

async function main(){
  await buildJs('app.src.js', 'app.js');
  await buildJs('boot.src.js', 'boot.js');
  buildCss('styles.src.css', 'styles.css');
  await buildHtml('index.src.html', 'index.html');
  await buildHtml('admin.src.html', 'admin.html');
}

main().catch((e) => { console.error(e); process.exit(1); });
