import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  GuildMember,
  Interaction,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  getFormFields,
  getLinkById,
  getTicketByChannel,
  getTicketById,
  getTicketType,
  updateTicket,
  upsertRating,
} from './db';
import { env } from './env';
import { linkSig } from './links';
import { COLORS, confirmRow, ephemeral, isStaff, ticketEmbed, controlButtons, pad } from './util';
import { closeTicket, createTicket, deleteTicket, logToGuild, reopenTicket } from './tickets';
import { handlePollVote, handleSuggestionVote } from './votes';
import { enterGiveaway, getGiveaway } from './db';
import { giveawayMessage } from './giveaways';
import { EmbedBuilder } from 'discord.js';

async function ticketModal(guildId: string, typeId: string): Promise<ModalBuilder> {
  const type = await getTicketType(guildId, typeId);
  const fields = await getFormFields(guildId, typeId);
  const modal = new ModalBuilder()
    .setCustomId(`ticketmodal:${typeId}`)
    .setTitle(`Open: ${type?.label ?? typeId}`.slice(0, 45));

  if (fields.length) {
    // custom form — up to 5 inputs (Discord modal cap)
    for (const [n, f] of fields.slice(0, 5).entries()) {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(`f${n}`)
            .setLabel(f.question.slice(0, 45))
            .setStyle(f.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(!!f.required)
            .setMaxLength(f.style === 'paragraph' ? 1000 : 200),
        ),
      );
    }
    return modal;
  }

  return modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('subject')
        .setLabel('Subject')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Describe your issue in detail')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000),
    ),
  );
}

export async function onInteraction(i: Interaction): Promise<void> {
  try {
    // instant-open types skip the modal entirely — click → ticket created
    const openOrModal = async (
      i2: ButtonInteraction | StringSelectMenuInteraction,
      typeId: string,
    ): Promise<void> => {
      if (!i2.guildId || !i2.isRepliable()) return;
      const t = await getTicketType(i2.guildId, typeId);
      if (t?.instant) {
        const guild = i2.guild ?? (await i2.client.guilds.fetch(i2.guildId).catch(() => null));
        if (!guild) return;
        const res = await createTicket(guild, i2.user, typeId, `${t.label} request`, null);
        await i2.reply(
          ephemeral(res.ok ? `✅ Ticket created: ${res.channel}` : `❌ ${res.reason}`),
        ).catch(() => {});
        return;
      }
      await i2.showModal(await ticketModal(i2.guildId, typeId));
    };

    // ---- select menus ----
    if (i.isStringSelectMenu() && i.customId === 'panel:select') {
      await openOrModal(i, i.values[0]);
      return;
    }

    // /issues picker — ephemeral self-service card with a tracked link button
    if (i.isStringSelectMenu() && i.customId === 'issues:pick' && i.guildId) {
      const link = await getLinkById(i.guildId, Number(i.values[0]));
      if (!link) {
        await i.reply(ephemeral('That issue link is no longer available — please ask staff.'));
        return;
      }
      const url = `${env.dashboardUrl}/go/${i.guildId}/${link.id}?u=${i.user.id}&s=${linkSig(i.guildId, link.id, i.user.id)}`;
      const embed = new EmbedBuilder()
        .setTitle(`${link.emoji ? `${link.emoji} ` : ''}${link.label}`)
        .setColor(COLORS.open)
        .setDescription(
          `${link.description ? `${link.description}\n\n` : ''}` +
            'This is a **self-service** resolution — click the button below to resolve your issue.',
        );
      await i.reply({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Resolve this issue').setEmoji('🔧'),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // ---- buttons ----
    if (i.isButton()) {
      const id = i.customId;

      if (id.startsWith('ticket:create:')) {
        await openOrModal(i, id.slice('ticket:create:'.length));
        return;
      }

      if (id.startsWith('gw:enter:')) {
        const g = await getGiveaway(Number(id.slice('gw:enter:'.length)));
        if (!g) return void (await i.reply(ephemeral('Giveaway not found.')));
        if (g.closed) return void (await i.reply(ephemeral('This giveaway has ended.')));
        const res = await enterGiveaway(g.id, i.user.id);
        await i.reply(ephemeral(res === 'entered' ? '🎉 You\'re in! Good luck.' : 'You left the giveaway.'));
        // refresh the entry count on the button
        const msg = i.message;
        await msg.edit(await giveawayMessage(g)).catch(() => {});
        return;
      }

      if (id.startsWith('sug:vote:')) {
        if (!i.inCachedGuild()) return;
        await handleSuggestionVote(i);
        return;
      }

      if (id.startsWith('poll:vote:')) {
        if (!i.inCachedGuild()) return;
        await handlePollVote(i);
        return;
      }

      if (id.startsWith('rate:')) {
        const [, tid, stars] = id.split(':');
        await i.showModal(
          new ModalBuilder()
            .setCustomId(`ratefb:${tid}:${stars}`)
            .setTitle(`Your ${stars}★ rating`)
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId('feedback')
                  .setLabel('Anything to add? (optional)')
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(false)
                  .setMaxLength(500),
              ),
            ),
        );
        return;
      }

      // everything below happens inside a ticket channel
      const t = i.channelId ? await getTicketByChannel(i.channelId) : undefined;
      const member = i.member as GuildMember | null;
      const staff = member ? await isStaff(member) : false;

      if (id === 'ticket:claim') {
        if (!staff || !t) return void (await i.reply(ephemeral('Staff only.')));
        if (t.status !== 'open') return void (await i.reply(ephemeral('Ticket is closed.')));
        if (t.claimed_by)
          return void (await i.reply(ephemeral(`Already claimed by <@${t.claimed_by}>.`)));
        await updateTicket(t.id, { claimed_by: i.user.id });
        const updated = (await getTicketById(t.id))!;
        await i.update({ embeds: [await ticketEmbed(updated)], components: [controlButtons(updated)] });
        if (i.channel?.isSendable()) {
          await i.channel.send(`🙋 Ticket claimed by ${i.user} — they'll be helping you.`);
        }
        return;
      }

      if (id === 'ticket:close') {
        if (!t) return;
        if (!staff && i.user.id !== t.owner_id)
          return void (await i.reply(ephemeral('Only staff or the ticket owner can close this.')));
        await i.reply({
          content: 'Close this ticket? A transcript will be saved.',
          components: [confirmRow('close')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (id === 'ticket:close-confirm') {
        if (!t) return;
        await i.update({ content: '🔒 Closing ticket…', components: [] });
        await closeTicket(i.client, t, i.user, null);
        return;
      }

      if (id === 'ticket:close-cancel' || id === 'ticket:delete-cancel') {
        await i.update({ content: 'Cancelled.', components: [] });
        return;
      }

      if (id === 'ticket:reopen') {
        if (!staff || !t) return void (await i.reply(ephemeral('Staff only.')));
        if (t.status !== 'closed') return void (await i.reply(ephemeral('Ticket is not closed.')));
        await i.deferUpdate();
        await reopenTicket(i.client, t);
        return;
      }

      if (id === 'ticket:delete') {
        if (!staff || !t) return void (await i.reply(ephemeral('Staff only.')));
        await i.reply({
          content: 'Permanently delete this ticket channel?',
          components: [confirmRow('delete')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (id === 'ticket:delete-confirm') {
        if (!staff || !t) return void (await i.reply(ephemeral('Staff only.')));
        await i.update({ content: '🗑️ Deleting…', components: [] });
        await deleteTicket(i.client, t, i.user);
        return;
      }
      return;
    }

    // ---- modals ----
    if (i.isModalSubmit()) {
      const id = i.customId;

      if (id.startsWith('ticketmodal:')) {
        const typeId = id.slice('ticketmodal:'.length);
        if (!i.guild) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const fields = (await getFormFields(i.guild.id, typeId)).slice(0, 5);
        let subject: string | null;
        let description: string | null;
        if (fields.length) {
          // custom form — pack answers into the ticket description
          const answers = fields.map(
            (f, n) => `**${f.question}**\n${i.fields.getTextInputValue(`f${n}`) || '—'}`,
          );
          subject = `${(await getTicketType(i.guild.id, typeId))?.label ?? typeId} request`;
          description = answers.join('\n\n').slice(0, 1000);
        } else {
          subject = i.fields.getTextInputValue('subject');
          description = i.fields.getTextInputValue('description');
        }
        const res = await createTicket(i.guild, i.user, typeId, subject, description);
        if (!res.ok) {
          await i.editReply({ content: `❌ ${res.reason}` });
        } else {
          await i.editReply({ content: `✅ Ticket created: ${res.channel}` });
        }
        return;
      }

      if (id.startsWith('ratefb:')) {
        const [, tid, stars] = id.split(':');
        const t = await getTicketById(Number(tid));
        if (!t) return void (await i.reply(ephemeral('Ticket not found.')));
        await upsertRating(t.id, i.user.id, Number(stars), i.fields.getTextInputValue('feedback') || null);

        // notify staff log of the rating
        const guild = await i.client.guilds.fetch(t.guild_id).catch(() => null);
        if (guild) {
          await logToGuild(
            guild,
            new EmbedBuilder()
              .setTitle(`Rating received — ticket #${pad(t.number)}`)
              .setColor(COLORS.warn)
              .setDescription(
                `${'⭐'.repeat(Number(stars))} (${stars}/5)` +
                  (i.fields.getTextInputValue('feedback')
                    ? `\n> ${i.fields.getTextInputValue('feedback')}`
                    : ''),
              ),
          );
        }
        await i.reply({ content: 'Thanks for the feedback! 💛', flags: MessageFlags.Ephemeral });
        return;
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply(ephemeral('Something went wrong.')).catch(() => {});
    }
  }
}
