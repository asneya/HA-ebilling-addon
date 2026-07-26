#!/usr/bin/with-contenv bashio

export DATA_DIR=/data
LOG_LEVEL=$(bashio::config 'log_level' 'info')
export LOG_LEVEL

bashio::log.info "Arrancando eBilling en el puerto 8099 (log: ${LOG_LEVEL})"

cd /opt/app || exit 1
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8099 --log-level "${LOG_LEVEL}"
