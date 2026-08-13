/**
 * Show-off script for the linear model. Run against a farm that has clone/truncate:
 *
 *   ABLY_KEY=... ABLY_HOST=127.0.0.1 ABLY_PORT=8081 npx tsx examples/linear-channel/show.ts
 *
 * Or read it as the API. Every behaviour is compose of clone / truncate / publish.
 */
import * as Ably from 'ably';
import { alternatives, cloneChannel, HEADER_TURN_ID, lastWrite, truncateAfter, visible } from './linear.ts';

function headers(turnId: string) {
	return { extras: { headers: { [HEADER_TURN_ID]: turnId } } };
}

async function main() {
	const key = process.env.ABLY_KEY;
	if (!key) {
		console.log('Set ABLY_KEY to run against a farm. The steps below are the whole API.');
		printWalkthrough();
		return;
	}

	const rest = new Ably.Rest({
		key,
		restHost: process.env.ABLY_HOST ?? '127.0.0.1',
		port: Number(process.env.ABLY_PORT ?? 8081),
		tls: false,
	});

	const src = `mutable:linear-src-${Date.now()}`;
	const ch = rest.channels.get(src);

	await ch.publish({ name: 'user', data: 'What is Rust?', ...headers('turn-1') });
	const a1 = await ch.publish({ name: 'assistant', data: 'Rust is a systems language.', ...headers('turn-2') });
	await ch.publish({ name: 'user', data: 'Give an example.', ...headers('turn-3') });
	await ch.publish({ name: 'assistant', data: 'fn main() {}', ...headers('turn-4') });

	// 1) Regenerate + 1/N: new message, same turn-id. Not a fork header.
	await ch.publish({ name: 'assistant', data: 'fn main() { println!("hi"); }', ...headers('turn-4') });
	let page = await ch.history({ direction: 'forwards' });
	const versions = alternatives(page.items, 'turn-4');
	console.log('1/N for turn-4', versions.map((m) => m.data), 'last-write', lastWrite(page.items, 'turn-4')?.data);

	// 2) Rewind to here: truncate after the first assistant reply. Same channel.
	const after = a1.serials?.[0];
	if (!after) {
		throw new Error('expected serial from first assistant publish');
	}
	await truncateAfter(rest, src, after);
	page = await ch.history({ direction: 'forwards' });
	console.log(
		'rewind visible',
		visible(page.items).map((m) => m.data),
	);

	// 3) Fork from a point: dest gets the prefix only. Source keeps the tail.
	const dest = `mutable:linear-fork-${Date.now()}`;
	const cloneRes = await cloneChannel(rest, src, dest, after);
	if (cloneRes.statusCode !== 200) {
		throw new Error(`clone failed ${cloneRes.statusCode} ${cloneRes.errorMessage}`);
	}
	const destPage = await rest.channels.get(dest).history({ direction: 'forwards' });
	console.log(
		'fork dest',
		destPage.items.map((m) => ({ data: m.data, action: m.action })),
	);
}

function printWalkthrough() {
	console.log(`
Send            publish
Regenerate      publish { turn-id: same }
1/N pager       group visible history by turn-id
Rewind          POST /truncate { afterSerial }
Edit            cancel + truncate + publish
Fork all        POST /clone { destChannel }
Fork from here  POST /clone { destChannel, untilSerial }
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
