FROM python:3.12-slim
WORKDIR /opt/llmspaghetti

# Install deps from router/requirements.txt
# Source code is mounted at runtime so edits don't require a rebuild.
COPY router/requirements.txt /tmp/router-requirements.txt
RUN pip install --no-cache-dir -r /tmp/router-requirements.txt

ENV PYTHONUNBUFFERED=1

CMD ["python", "router/main.py"]
