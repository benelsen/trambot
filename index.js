
import fs from 'fs';
import util from 'util';

import qs from 'qs';
import request from 'request';
import Bluebird from 'bluebird';
import readline from 'readline-sync';

import Twitter from './twitter-plus';

Bluebird.promisifyAll(fs);

let blacklist, whitelist, adminlist, user, userStream, trackStream;

let active = true;

(async function main () {

  const config = await loadConfig();

  const client = new Twitter(Object.assign({}, config.application, config.client));

  [user] = await client.getAsync('account/verify_credentials');

  [blacklist, whitelist, adminlist] = await getLists(client);

  startUserStream(client);
  startTrackStream(client);

})();

async function getLists (client) {

  const [{lists}] = await client.getAsync('lists/ownerships');

  const opts = {
    include_entities: false,
    skip_status: true
  };

  const blacklistId = lists.find(l => l.slug === 'blacklist').id_str;
  const whitelistId = lists.find(l => l.slug === 'whitelist').id_str;
  const adminlistId = lists.find(l => l.slug === 'adminlist').id_str;

  const [blacklist, whitelist, adminlist] = await Promise.all([
    client.getCursored('lists/members', 'users', Object.assign({}, opts, {list_id: blacklistId })),
    client.getCursored('lists/members', 'users', Object.assign({}, opts, {list_id: whitelistId })),
    client.getCursored('lists/members', 'users', Object.assign({}, opts, {list_id: adminlistId })),
  ]);

  return [
    { id: blacklistId, name: 'blacklist', members: blacklist.map(e => e.id_str) },
    { id: whitelistId, name: 'whitelist', members: whitelist.map(e => e.id_str) },
    { id: adminlistId, name: 'adminlist', members: adminlist.map(e => e.id_str) },
  ];
}

async function loadConfig() {

  let config;

  try {
    const json = await fs.readFileAsync('./config.json');
    config = JSON.parse( json );
  } catch (e) {
    console.error('Failed to load config, from file');
    config = undefined;
  }

  if ( config && config.application && config.client &&
      config.application.consumer_key && config.application.consumer_secret &&
      config.client.access_token_key && config.client.access_token_secret ) {
    return config;
  } else {
    config = {application: {}, client: {}};
  }

  config.application.consumer_key    = readline.question('Consumer Key:');
  config.application.consumer_secret = readline.question('Consumer Secret:');
  config.client.access_token_key     = readline.question('Access Token Key:');
  config.client.access_token_secret  = readline.question('Access Token Secret:');

  if ( readline.keyInYN('Save?') ) {
    await fs.writeFileAsync('./config.json', JSON.stringify(config, null, 2));
  }

  return config;
}

process.on('uncaughtExceptions', function(e) {
  console.error('uncaughtExceptions', e.stack);
});

process.on('unhandledRejection', function(e, promise) {
  console.error('unhandledRejection', e.stack, promise);
});

function startUserStream (client) {

  console.info('Starting user stream…');

  client.stream('user', {
    stringify_friend_ids: true
  }, function (stream) {

    console.info('Started user stream…');

    userStream = stream;

    stream.on('data', function (data) {

      if ( data.direct_message ) {
        return handleDirectMessage(client, data.direct_message);
      }

    });

    stream.on('error', function (error) {
      console.error('User Stream', util.inspect(error, {depth: null, colors: true}));
    });

    stream.on('end', function() {
      console.info('User Stream', 'User stream ended');
    });

  });
}

function startTrackStream (client) {

  console.info('Starting track stream…');

  client.stream('statuses/filter', {
    stringify_friend_ids: true,
    locations: [5.73, 49.44, 6.54, 50.19].join(','),
    follow: whitelist.members.join(',')
  }, function (stream) {

    console.info('Started track stream…');

    trackStream = stream;

    const tramRE = /(^|\W)(Tram)(\W|$)/i;

    stream.on('data', function (data) {

      if ( data.text && !data.retweeted_status && tramRE.test(data.text) ) {

        if ( data.user && whitelist.members.includes(data.user.id_str) ) {
          reply(client, data);
        }

        if ( data.place && data.place.country_code === 'LU' ) {
          console.log(util.inspect({
            created_at: data.created_at,
            text: data.text,
            user: {id_str: data.user.id_str, screen_name: data.user.screen_name, location: data.user.location},
            geo: data.geo,
            coordinates: data.coordinates,
            place: data.place,
            lang: data.lang,
          }, {depth: null, colors: true}));
        }

      }

    });

    stream.on('error', function (error) {
      console.error('Track Stream', util.inspect(error, {depth: null, colors: true}));
    });

    stream.on('end', function() {
      console.info('Track Stream', 'Track stream ended');
    });

  });
}

function handleDirectMessage (client, data) {

  if ( data.sender.id_str === user.id_str ) {
    return;
  }

  commands(client, data, data.sender)

}

function commands (client, data, sender) {

  const isAdmin = adminlist.members.includes( sender.id_str );

  console.info(`GOT MSG FROM ${sender.screen_name}: ${data.text}`);

  const match = data.text.match(/^(?:@\w+ )?([A-Z]+)(.*)/);

  let command, args;

  if (match) {
    command = match[1];
    args = match[2].split(' ').map(a => a.trim()).filter(a => a.length > 0);
  } else {
    command = null;
    args = [];
  }

  const sub = args[0];

  switch (command) {

    case 'WHITELIST':

      args = args.slice(1);

      if ( !isAdmin ) {
        args = args.filter(a => a === sender.screen_name);
        if ( args.length === 0 ) {
          denied(client, sender);
          break;
        }
      }

      addRemoveToList(client, whitelist, args, sender, sub);
      break;

    case 'BLACKLIST':

      args = args.slice(1);

      if ( !isAdmin ) {
        args = args.filter(a => a === sender.screen_name);
        if ( args.length === 0 ) {
          denied(client, sender);
          break;
        }
      }

      addRemoveToList(client, blacklist, args, sender, sub);
      break;

    case 'STOP':
      if ( !isAdmin ) {
        denied(client, sender);
        break;
      }
      stop(client, sender);
      break;

    case 'START':
      if ( !isAdmin ) {
        denied(client, sender);
        break;
      }
      start(client, sender);
      break;

    default:
      notUnderstood(client, sender);

  }

}

async function notUnderstood (client, user) {

  const [result] = await client.postAsync('direct_messages/new', {
    user_id: user.id_str,
    text: `Sorry ${user.name}, I don’t understand.`
  });
  return result;

}

async function denied (client, user) {

  const [result] = await client.postAsync('direct_messages/new', {
    user_id: user.id_str,
    text: `Sorry ${user.name}, you can’t do that.`
  });
  return result;

}

async function addRemoveToList (client, list, args, user, sub) {

  let method, verb;
  if ( sub === 'ADD' ) {
    method = 'create_all';
    verb = 'Added';
  } else if ( sub === 'RM' ) {
    method = 'destroy_all';
    verb = 'Removed';
  } else {
    notUnderstood(client, user);
  }

  const [result] = await client.postAsync(`lists/members/${method}`, {
    list_id: list.id,
    screen_name: args.join(',')
  });

  if ( trackStream ) {
    trackStream.destroy();
    setTimeout(function() {
      startTrackStream(client);
    }, 30000);
  }

  if ( result && user ) {

    let [resultDM] = await client.postAsync('direct_messages/new', {
      user_id: user.id_str,
      text: `${verb} ${args.join(', ')} to ${list.name}`
    });
    return resultDM;

  }

}

async function stop (client, user) {
  active = false;
  console.info('STOPPED');

  if ( user ) {

    let [resultDM] = await client.postAsync('direct_messages/new', {
      user_id: user.id_str,
      text: 'I’m now quiet.'
    });
    return resultDM;

  }
}

async function start (client, user) {
  active = true;
  console.info('STARTED');

  if ( user ) {

    let [resultDM] = await client.postAsync('direct_messages/new', {
      user_id: user.id_str,
      text: 'Replying to users now.'
    });
    return resultDM;

  }
}

async function reply (client, tweet) {

  console.info('>>', '@' + tweet.user.screen_name + ':', tweet.text);

  if (!active) {
    console.info('NOT ACTIVE');
    return false;
  }

  if ( blacklist.members.includes(tweet.user.id_str) ) {
    console.info('Blacklisted user');
    return false;
  }

  const [result] = await client.postAsync('statuses/update', {
    status: `@${tweet.user.screen_name} A WEEN SOLL DAT BEZUELEN?!?!`,
    in_reply_to_status_id: tweet.id_str
  });

  console.info('<<', result.text);

  return result;

}
