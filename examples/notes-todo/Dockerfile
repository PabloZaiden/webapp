ARG RUNTIME_IMAGE=node:22-bookworm
ARG APP_BINARY=examples/notes-todo/dist/notes-todo-linux-arm64

FROM ${RUNTIME_IMAGE}
ARG APP_BINARY=examples/notes-todo/dist/notes-todo-linux-arm64
WORKDIR /app
COPY ${APP_BINARY} /app/notes-todo
RUN groupadd --system notes-todo && useradd --system --gid notes-todo --no-create-home notes-todo
RUN mkdir -p /app/data && chown -R notes-todo:notes-todo /app/data
ENV NODE_ENV=production
ENV NOTES_TODO_HOST=0.0.0.0
ENV NOTES_TODO_PORT=8080
ENV NOTES_TODO_DATA_DIR=/app/data
EXPOSE 8080
USER notes-todo
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + process.env.NOTES_TODO_PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["/app/notes-todo", "serve"]
