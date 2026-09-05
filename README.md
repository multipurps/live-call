# live-call
Real-time AI video call

## Editing this app
The files actually served (`app.js`, `boot.js`, `index.html`, `styles.css`,
`admin.html`) are generated, minified output - comments and readable
formatting are stripped so the app doesn't ship a readable narration of its
own architecture/provider choices to anyone who loads the URL or views
source. **Edit the `.src.` files instead** (`app.src.js`, `boot.src.js`,
`index.src.html`, `styles.src.css`, `admin.src.html`), then run:

```
npm install   # first time only
npm run minify
```

...to regenerate the served files before committing. Committing only a
`.src.` change without rebuilding will leave the live site running the old
code.
