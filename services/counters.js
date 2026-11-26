module.exports = function registerCounters(client, config) {
	if (!config) {
		console.warn('[counters] geen config gevonden, sla counters over.');
		return;
	}

	let memberCountEnabled = config.features.memberCount !== false;
	let boosterCountEnabled = config.features.nitroBoosterCount !== false;

	const pending = new Map();

	const formatCount = (n) => {
		if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
		if (n < 1500) return String(n);
		const oneDecimalK = Math.floor(n / 100) / 10;
		return `${oneDecimalK.toFixed(1)}K`;
	};

	const scheduleUpdate = (guild) => {
		if (!memberCountEnabled || !guild) return;
		const gid = guild.id;
		if (pending.has(gid)) clearTimeout(pending.get(gid));
		const t = setTimeout(() => {
			pending.delete(gid);
			updateMemberCounter(guild).catch((e) => console.error('[counters] Fout bij bijwerken leden-counter:', e));
		}, 2000);
		pending.set(gid, t);
	};

	const updateMemberCounter = async (guild) => {
		if (!memberCountEnabled) return;
		try {
			let channel = guild.channels.cache.get(config.counters.userCountChannelId);
			if (!channel) {
				try {
					channel = await guild.channels.fetch(config.counters.userCountChannelId);
				} catch (_) {
				}
			}
			if (!channel) return;

			const memberCount = typeof guild.memberCount === 'number' ? guild.memberCount : (await guild.members.fetch()).size;
			const newName = `SCHIZOS: ${formatCount(memberCount)}`;

			if (channel.name !== newName && typeof channel.setName === 'function') {
				await channel.setName(newName, 'Auto-update leden counter');
			}
		} catch (err) {
			console.error('[counters] Onverwachte fout:', err);
		}
	};

	const updateBoosterCounter = async (guild) => {
		if (!boosterCountEnabled) return;
		try {
			let channel = guild.channels.cache.get(config.counters.nitroBoosterCountChannelId);
			if (!channel) {
				try {
					channel = await guild.channels.fetch(config.counters.nitroBoosterCountChannelId);
				} catch (_) {}
			}
			if (!channel) return;

			const boosterRole = guild.roles.premiumSubscriberRole;
			const uniqueBoosterIds = new Set();

			if (boosterRole?.members?.size) {
				for (const [memberId] of boosterRole.members) uniqueBoosterIds.add(memberId);
			}

			const fullyCached = guild.members.cache.size === guild.memberCount;
			const members = fullyCached ? guild.members.cache : await guild.members.fetch();

			for (const [, member] of members) {
				const isBooster = Boolean(member.premiumSince || member.premiumSinceTimestamp || (boosterRole && member.roles.cache.has(boosterRole.id)));
				if (isBooster) uniqueBoosterIds.add(member.id);
			}

			const boosterCount = uniqueBoosterIds.size;
			const newName = `NITRO GEKKIES: ${boosterCount}`;
			if (channel.name !== newName && typeof channel.setName === 'function') {
				await channel.setName(newName, 'Auto-update booster counter');
			}
		} catch (err) {
			console.error('[counters] Fout bij bijwerken booster-counter:', err);
		}
	};

	client.once('clientReady', () => {
		for (const [, guild] of client.guilds.cache) {
			scheduleUpdate(guild);
			updateBoosterCounter(guild).catch(() => {});
		}
	});

	client.on('guildMemberAdd', (member) => {
		scheduleUpdate(member.guild);
		updateBoosterCounter(member.guild).catch(() => {});
	});
	client.on('guildMemberRemove', (member) => {
		scheduleUpdate(member.guild);
		updateBoosterCounter(member.guild).catch(() => {});
	});

	client.on('guildMemberUpdate', (_oldMember, newMember) => {
		updateBoosterCounter(newMember.guild).catch(() => {});
	});
};

