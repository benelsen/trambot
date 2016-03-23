
import fs from 'fs';
import util from 'util';

import "babel-polyfill";

import uniq from 'lodash.uniq';
import moment from 'moment';
import Bluebird from 'bluebird';
import readline from 'readline-sync';

import Twitter from './twitter-plus';

Bluebird.promisifyAll(fs);

let blacklist, whitelist, adminlist, botUser;

let active = true;

const replyTimes = new Map();

const tramRE = /(^|\W)(Tram)(\W|$)/i;

async function main () {

  const config = await loadConfig();

  const client = new Twitter(Object.assign({}, config.application, config.client));

  try {
    botUser = await client.getAsync('account/verify_credentials');
  } catch (e) {
    if (e[0] && e[0].code && e[0].code === 88) {
      console.info(e[0].message);
      setTimeout(main, 5*60e3);
      return;
    }
  }

  [blacklist, whitelist, adminlist] = await getLists(client);

  startUserStream(client);
  startTrackStream(client);

}

process.on('uncaughtExceptions', function(e) {
  console.error('uncaughtExceptions', e.stack);
});

process.on('unhandledRejection', function(e, promise) {
  console.error('unhandledRejection', e, promise);
});

async function getLists (client) {

  const {lists} = await client.getAsync('lists/ownerships');

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
    { id: blacklistId, name: 'blacklist', members: blacklist.map(e => e.screen_name) },
    { id: whitelistId, name: 'whitelist', members: whitelist.map(e => e.screen_name) },
    { id: adminlistId, name: 'adminlist', members: adminlist.map(e => e.screen_name) },
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

function startUserStream (client) {

  console.info('User Stream:', 'starting');

  client.stream('user', {
    stringify_friend_ids: true
  }, function (stream) {

    console.info('User Stream:', 'started');

    stream.on('data', function (data) {

      if ( data.direct_message ) {
        return handleDirectMessage(client, data.direct_message);
      }

    });

    stream.on('error', function (error) {
      console.error('User Stream', 'error', error.stack, error.source);
    });

    stream.on('end', function() {
      console.info('User Stream:', 'ended');

      setTimeout(function() {
        startUserStream(client);
      }, 30e3);
    });

  });
}

function startTrackStream (client) {

  console.info('Track Stream:', 'starting');

  client.stream('statuses/filter', {
    stringify_friend_ids: true,
    locations: [
      ...[5.721, 49.747, 6.274, 50.184],
      ...[5.798, 49.441, 6.559, 49.886],
    ].join(','),
    track: 'tram'
  }, function (stream) {

    console.info('Track Stream:', 'started');

    stream.on('data', function (data) {

      // look for tweets mentioning the magic word and discard retweets
      if ( data.text && !data.retweeted_status && tramRE.test(data.text) ) {

        // Reply to whitelisted accounts
        if ( data.user && whitelist.members.includes(data.user.screen_name) ) {

          reply(client, data);

        // Check if tweet is from LU and log it
        } else if ( data.place && data.place.country_code === 'LU' ) {

          console.info('Location + Tram:', util.inspect({
            created_at: data.created_at,
            text: data.text,
            user: {id_str: data.user.id_str, screen_name: data.user.screen_name, location: data.user.location},
            coordinates: data.coordinates,
            place: data.place,
            lang: data.lang,
          }, {depth: null, colors: true}));

        }

      }

    });

    stream.on('error', function (error) {
      console.error('Track Stream', 'error', error.stack, error.source);
    });

    stream.on('end', function() {
      console.info('Track Stream:', 'ended');

      setTimeout(function() {
        startTrackStream(client);
      }, 30e3);
    });

  });
}

function handleDirectMessage (client, data) {

  if ( data.sender.id_str === botUser.id_str ) {
    return;
  }

  commands(client, data, data.sender)

}

function commands (client, data, sender) {

  const isAdmin = adminlist.members.includes( sender.id_str );

  console.info(`GOT MSG FROM ${sender.screen_name}: ${data.text}`);

  const match = data.text.match(/^(?:@\w+ )?([A-Z]+)(.*)/);

  console.log(data.text, match);

  let command, args;

  if (match) {
    command = match[1].toString().toLowerCase();
    args = match[2].split(' ').map(a => a.trim()).filter(a => a.length > 0);
  } else {
    command = null;
    args = [];
  }

  const sub = args[0];

  switch (command) {

    case 'whitelist':
    case 'wl':

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

    case 'blacklist':
    case 'bl':

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

    case 'stop':
      if ( !isAdmin ) {
        denied(client, sender);
        break;
      }
      stop(client, sender);
      break;

    case 'start':
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

  const result = await client.postAsync('direct_messages/new', {
    user_id: user.id_str,
    text: `Sorry ${user.name}, I don’t understand.`
  });
  return result;

}

async function denied (client, user) {

  const result = await client.postAsync('direct_messages/new', {
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

  const result = await client.postAsync(`lists/members/${method}`, {
    list_id: list.id,
    screen_name: args.join(',')
  });

  if ( result && user ) {

    let resultDM = await client.postAsync('direct_messages/new', {
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

    let resultDM = await client.postAsync('direct_messages/new', {
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

    let resultDM = await client.postAsync('direct_messages/new', {
      user_id: user.id_str,
      text: 'Replying to users now.'
    });
    return resultDM;

  }
}

async function reply (client, tweet) {

  console.info('>>', '@' + tweet.user.screen_name + ':', tweet.text);

  // Do not reply from users on the blacklist
  if ( blacklist.members.includes(tweet.user.screen_name) ) {
    console.info('Blacklisted user');
    return false;
  }

  // Do not reply to tweets from users that we’ve bothered in the last 6h
  if ( replyTimes.get(tweet.user.screen_name) && moment( replyTimes.get(tweet.user.screen_name) ).isAfter( moment().subtract(6, 'hours') ) ) {
    console.info('Can’t annoy a user more than once every 6 hours');
    return false;
  }

  let users = uniq([
    tweet.user.screen_name,
    ...tweet.entities.user_mentions.map(u => u.screen_name)
  ]);

  // Filter out the users we’ve already bothered in the last 6h, blacklisted users and the bot itself.
  users = users
    .filter( u => !replyTimes.get(u) || moment( replyTimes.get(u) ).isAfter( moment().subtract(6, 'hours') ) )
    .filter( u => !blacklist.members.includes(u) )
    .filter( u => u !== botUser.screen_name );

  const message = 'A WEEN SOLL DAT BEZUELEN?!?!';

  let status;
  while ( true ) {
    status = `${ users.map(u => '@' + u).join(' ') } ${message}`;
    if ( status.length > 140 ) {
      users.pop();
    } else {
      break;
    }
  }

  if ( active ) {
    const result = await client.postAsync('statuses/update', {
      status,
      in_reply_to_status_id: tweet.id_str
    });

    console.info('<<', result.text);

    // Set the new reply time for every mentioned user
    users.forEach( u => replyTimes.set(u, new Date().toISOString() ) );

    return result;

  } else {
    console.info('NOT ACTIVE', '<<', status);
  }

}

main()
