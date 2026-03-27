import { SlashCommandBuilder, MessageFlags } from "discord.js";

// Minimal fallback ticket system.
// Keeps the bot bootable when the full ticket module is not present.
export const ticketCommands = [
    new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Ticket system placeholder")
        .addSubcommand(sub =>
            sub.setName("status")
                .setDescription("Show ticket system status")
        )
];

export function createTicketSystem() {
    return {
        async handleButtonInteraction() {
            return false;
        },
        async handleModalSubmit() {
            return false;
        },
        async handleChatInputCommand(interaction) {
            if (!interaction.isChatInputCommand()) {
                return false;
            }

            if (interaction.commandName !== "ticket") {
                return false;
            }

            await interaction.reply({
                content: "Ticket system module is not installed on this deployment yet.",
                flags: MessageFlags.Ephemeral
            });

            return true;
        }
    };
}
