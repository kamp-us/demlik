#!/bin/sh
exec /Users/cansirin/Documents/development/demlik/node_modules/.bin/tsc --noEmit --strict \
  --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022 \
  --noUncheckedIndexedAccess --skipLibCheck --pretty false \
  --typeRoots /Users/cansirin/Documents/development/demlik/node_modules/@types --types node "$@"
