ARG RUNTIME_IMAGE=node:22-bookworm
ARG APP_BINARY=examples/kitchen-sink/dist/kitchen-sink-linux-arm64

FROM ${RUNTIME_IMAGE}
ARG APP_BINARY=examples/kitchen-sink/dist/kitchen-sink-linux-arm64
WORKDIR /app
COPY ${APP_BINARY} /app/kitchen-sink
RUN groupadd --system kitchen-sink && useradd --system --gid kitchen-sink --no-create-home kitchen-sink
RUN mkdir -p /app/data && chown -R kitchen-sink:kitchen-sink /app/data
ENV NODE_ENV=production
ENV KITCHEN_SINK_HOST=0.0.0.0
ENV KITCHEN_SINK_PORT=8080
ENV KITCHEN_SINK_DATA_DIR=/app/data
EXPOSE 8080
USER kitchen-sink
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + process.env.KITCHEN_SINK_PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["/app/kitchen-sink", "serve"]
