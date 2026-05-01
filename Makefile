.PHONY: help install setup check-env dev lint build

help:
	@echo "Inbox Concierge — common targets"
	@echo "  make install   — npm ci"
	@echo "  make setup     — copy .env.example → .env.local if missing"
	@echo "  make check-env — verify required env vars (also: npm run check-env)"
	@echo "  make dev       — npm run dev"
	@echo "  make lint      — npm run lint"
	@echo "  make build     — npm run build"

install:
	npm ci

setup:
	@test -f .env.local || cp .env.example .env.local
	@echo "Edit .env.local, then: make check-env && make dev"

check-env:
	npm run check-env

dev:
	npm run dev

lint:
	npm run lint

build:
	npm run build
