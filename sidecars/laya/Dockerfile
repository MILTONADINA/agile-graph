FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu \
    && python -m pip install --no-cache-dir -r requirements.txt
COPY server.py /app/server.py
ENV GRAPH_LAYA_CONTAINER=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
USER 65532:65532
EXPOSE 7337
ENTRYPOINT ["python", "/app/server.py"]
CMD ["serve", "--directory", "/models", "--container", "--device", "cpu"]
