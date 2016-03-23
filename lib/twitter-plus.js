
import qs from 'qs';
import request from 'request';
import Twitter from 'twitter';
import Bluebird from 'bluebird';
import readline from 'readline-sync';

Bluebird.promisifyAll(request);
Bluebird.promisifyAll(Twitter.prototype);

export default class TwitterPlus extends Twitter {

  constructor (...args) {
    super(...args);
  }

  async getCursored (endpoint, field, options) {

    const data = [];
    options.cursor = -1;

    do {

      const result = await this.getAsync(endpoint, options);
      data.push(...result[field]);

      options.cursor = result.next_cursor_str;

    } while (+options.cursor !== 0 );

    return data;
  }

  static async getAccessToken (credentials) {

    const requestTokenBody = await request.postAsync({
      url: 'https://api.twitter.com/oauth/request_token',
      oauth: {
        callback: 'oob',
        consumer_key: credentials.consumer_key,
        consumer_secret: credentials.consumer_secret,
      }
    });

    const {oauth_token, oauth_token_secret} = qs.parse(requestTokenBody);

    const uri = 'https://api.twitter.com/oauth/authenticate' + '?' + qs.stringify({oauth_token});

    const verifier = readline.question('Go to ' + uri + ' and enter the displayed PIN here.\nPIN: ');

    const accessTokenBody = await request.postAsync({
      url: 'https://api.twitter.com/oauth/access_token',
      oauth: {
        consumer_key: credentials.consumer_key,
        consumer_secret: credentials.consumer_secret,
        token: oauth_token,
        token_secret: oauth_token_secret,
        verifier,
      }
    });

    const {oauth_token: access_token_key, oauth_token_secret: access_token_secret} = qs.parse(accessTokenBody)

    return {access_token_key, access_token_secret};
  }

}
