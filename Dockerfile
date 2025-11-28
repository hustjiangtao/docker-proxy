FROM oven/bun:alpine
WORKDIR /app
COPY index.js .
EXPOSE 3000
CMD ["bun", "index.js"]