ARG RUNTIME_IMAGE=node:22-bookworm
ARG APP_BINARY

FROM ${RUNTIME_IMAGE}
ARG APP_BINARY
ARG TARGETOS
ARG TARGETARCH
RUN set -eu; \
    if [ -z "${APP_BINARY}" ]; then \
      echo "APP_BINARY is required. Build a Linux binary and pass --build-arg APP_BINARY=<matching binary path>." >&2; \
      exit 1; \
    fi; \
    case "${TARGETOS}/${TARGETARCH}" in \
      linux/amd64) expected="examples/notes-todo/dist/notes-todo-linux-x64" ;; \
      linux/arm64) expected="examples/notes-todo/dist/notes-todo-linux-arm64" ;; \
      *) \
        echo "Unsupported target platform: ${TARGETOS}/${TARGETARCH}. Supported platforms are linux/amd64 and linux/arm64." >&2; \
        exit 1 \
        ;; \
    esac; \
    if [ "${APP_BINARY}" != "${expected}" ]; then \
      echo "APP_BINARY '${APP_BINARY}' does not match target ${TARGETOS}/${TARGETARCH}. Expected '${expected}'." >&2; \
      exit 1; \
    fi
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
