FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv
FROM mcr.microsoft.com/devcontainers/python:1-3.13-bookworm@sha256:0aa711e570b306c02946cdda67587ce8c65978dbb65691341cbcfd4854dfcfff

COPY --from=uv /uv /usr/local/bin/uv

ARG TARGETARCH
ARG AWS_CLI_VERSION=2.39.5
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) aws_arch=x86_64; checksum=fe0553306b3d001d162bc193d3b040027aab3466b9f910b50e702c122c0f3ff9 ;; \
      arm64) aws_arch=aarch64; checksum=ce7b03ebceed1dc6a0a8f27134a41a9a3b5671f09c57ab2e7fc6d43710dbaef3 ;; \
      *) echo "Unsupported AWS CLI architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    installer=$(mktemp -d); \
    cd "$installer"; \
    curl -fsSLo aws.zip "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}-${AWS_CLI_VERSION}.zip"; \
    echo "$checksum  aws.zip" | sha256sum -c -; \
    unzip -q aws.zip; \
    ./aws/install; \
    cd /; \
    rm -rf "$installer"
