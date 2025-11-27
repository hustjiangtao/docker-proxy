# Start by building the application.
FROM oven/bun:alpine as build

WORKDIR /app
COPY ./index.js .
RUN bun build --compile --target=bun-linux-x64 --minify --sourcemap --bytecode ./index.js --outfile dockerproxy

# Now copy it into our base image.
FROM gcr.io/distroless/static-debian12
COPY --from=build /app/dockerproxy /
CMD ["./dockerproxy"]