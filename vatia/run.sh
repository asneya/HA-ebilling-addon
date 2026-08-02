#!/usr/bin/with-contenv bashio

export DATA_DIR=/data
LOG_LEVEL=$(bashio::config 'log_level' 'info')
export LOG_LEVEL

# Con qué rol se recibe a quien entra por primera vez. Se elige en las opciones
# del add-on porque ahí solo llega un administrador de Home Assistant: es la
# única puerta para arrancar el reparto de permisos sin necesitar ya uno.
VATIA_FIRST_USER_ROLE=$(bashio::config 'first_user_role' 'primero')
export VATIA_FIRST_USER_ROLE

bashio::log.info "Arrancando Vatia en el puerto 8099 (log: ${LOG_LEVEL}, \
usuarios nuevos: ${VATIA_FIRST_USER_ROLE})"

cd /opt/app || exit 1
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8099 --log-level "${LOG_LEVEL}"
