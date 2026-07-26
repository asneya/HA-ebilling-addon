ARG BUILD_FROM
FROM $BUILD_FROM

# La versión del add-on, para poder enseñarla en Ajustes. El builder de Home
# Assistant pasa BUILD_VERSION; el config.yaml se copia también porque un build
# local puede no pasar el argumento y es la fuente de la verdad.
ARG BUILD_VERSION=""
ENV VATIA_VERSION=$BUILD_VERSION

WORKDIR /opt/app

COPY app/requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY app/ ./
COPY config.yaml ./addon.yaml
COPY run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 8099

CMD ["/run.sh"]
