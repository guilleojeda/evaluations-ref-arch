FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv
FROM mcr.microsoft.com/devcontainers/python:1-3.13-bookworm@sha256:0aa711e570b306c02946cdda67587ce8c65978dbb65691341cbcfd4854dfcfff

COPY --from=uv /uv /usr/local/bin/uv

ARG TARGETARCH
ARG NODE_VERSION=24.22.2
ARG NODE_X64_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
ARG NODE_ARM64_SHA256=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
ARG AWS_CLI_VERSION=2.39.5
ARG AWS_CLI_X64_SHA256=fe0553306b3d001d162bc193d3b040027aab3466b9f910b50e702c122c0f3ff9
ARG AWS_CLI_ARM64_SHA256=ce7b03ebceed1dc6a0a8f27134a41a9a3b5671f09c57ab2e7fc6d43710dbaef3

RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends ca-certificates curl git unzip xz-utils; \
    case "$TARGETARCH" in \
      amd64) node_arch=x64; node_checksum="$NODE_X64_SHA256"; aws_arch=x86_64; aws_checksum="$AWS_CLI_X64_SHA256" ;; \
      arm64) node_arch=arm64; node_checksum="$NODE_ARM64_SHA256"; aws_arch=aarch64; aws_checksum="$AWS_CLI_ARM64_SHA256" ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    node_directory="$(mktemp -d)"; \
    curl --fail --silent --show-error --location --output "$node_directory/$node_archive" \
      "https://nodejs.org/dist/v${NODE_VERSION}/$node_archive"; \
    echo "$node_checksum  $node_directory/$node_archive" | sha256sum --check --strict; \
    tar --extract --xz --file "$node_directory/$node_archive" --strip-components=1 --directory /usr/local; \
    rm -rf "$node_directory"; \
    aws_directory="$(mktemp -d)"; \
    curl --fail --silent --show-error --location --output "$aws_directory/aws.zip" \
      "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}-${AWS_CLI_VERSION}.zip"; \
    echo "$aws_checksum  $aws_directory/aws.zip" | sha256sum --check --strict; \
    unzip -q "$aws_directory/aws.zip" -d "$aws_directory"; \
    "$aws_directory/aws/install"; \
    rm -rf "$aws_directory"; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    node --version; \
    npm --version; \
    uv --version; \
    aws --version
