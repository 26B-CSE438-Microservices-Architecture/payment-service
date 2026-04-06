-- CreateTable
CREATE TABLE "saved_cards" (
    "id" VARCHAR(50) NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "card_user_key" VARCHAR(100) NOT NULL,
    "card_token" VARCHAR(100) NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "card_type" VARCHAR(20),
    "card_association" VARCHAR(20),
    "card_bank_name" VARCHAR(100),
    "card_alias" VARCHAR(100),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_saved_cards_user_token" ON "saved_cards"("user_id", "card_token");

-- CreateIndex
CREATE INDEX "idx_saved_cards_user_id" ON "saved_cards"("user_id");
