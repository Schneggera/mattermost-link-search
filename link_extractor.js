// ==UserScript==
// @name        Mattermost Link Extractor
// @description Extract links from Mattermost channels
// @namespace   Violentmonkey Scripts
// @version     1.0.0
// @match       YourURL
// @downloadURL https://raw.githubusercontent.com/Schneggera/mattermost-link-search/refs/heads/main/link_extractor.js
// @updateURL   https://raw.githubusercontent.com/Schneggera/mattermost-link-search/refs/heads/main/link_extractor.js
// ==/UserScript==

(function () {
  const baseUrl = GM_info.script.matches[0].split('/*')[0];

  function getCsrfToken() {
    const match = document.cookie.match(/MMCSRF=([^;]+)/);
    return match ? match[1] : '';
  }

  async function getChannelId(teamName, routeType, routeName) {
    if (routeType === 'messages') {
      const username = routeName.replace(/^@/, '');

      const meRes = await fetch(`${baseUrl}/api/v4/users/me`, { credentials: 'include' });
      if (!meRes.ok) throw new Error(`Could not fetch current user (${meRes.status})`);
      const me = await meRes.json();

      const userRes = await fetch(`${baseUrl}/api/v4/users/username/${username}`, { credentials: 'include' });
      if (!userRes.ok) throw new Error(`Could not find user "${username}" (${userRes.status})`);
      const otherUser = await userRes.json();

      const dmRes = await fetch(`${baseUrl}/api/v4/channels/direct`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify([me.id, otherUser.id])
      });
      if (!dmRes.ok) throw new Error(`Could not open DM channel (${dmRes.status})`);
      const dmChannel = await dmRes.json();
      return dmChannel.id;
    } else {
      // Regular channel
      const channelRes = await fetch(
        `${baseUrl}/api/v4/teams/name/${teamName}/channels/name/${routeName}`,
        { credentials: 'include' }
      );
      if (!channelRes.ok) throw new Error(`Could not find channel "${routeName}" (${channelRes.status})`);
      const channel = await channelRes.json();
      return channel.id;
    }
  }

  async function getUsernameMap(userIds) {
    const uniqueIds = [...new Set(userIds)];
    const res = await fetch(`${baseUrl}/api/v4/users/ids`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken()
      },
      body: JSON.stringify(uniqueIds)
    });
    if (!res.ok) return {};
    const users = await res.json();
    const map = {};
    users.forEach(u => { map[u.id] = u.username; });
    return map;
  }

  function renderList(list, results) {
    list.innerHTML = '';
    results.forEach((r) => {
      const li = document.createElement('li');
      li.style.cssText = 'margin: 8px 0; word-break: break-all;';
      li.innerHTML = `<a href="${r.link}" target="_blank" style="color: #1a73e8;">${r.link}</a>
        <a href="${r.permalink}" target="_blank" style="margin-left: 8px; color: #888; font-size: 0.85em;">(jump to message)</a>
        <div style="color: #888; font-size: 0.8em; margin-top: 2px;">${r.username} &middot; ${r.date}</div>`;
      list.appendChild(li);
    });
  }

  function showResults(results, routeName) {
    const existing = document.getElementById('link-extractor-modal');
    if (existing) existing.remove();

    results.sort((a, b) => b.createAt - a.createAt);

    const overlay = document.createElement('div');
    overlay.id = 'link-extractor-modal';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: white; padding: 20px; border-radius: 8px;
      max-width: 600px;
    `;

    const title = document.createElement('h3');
    title.textContent = `${results.length} links in "${routeName}"`;
    box.appendChild(title);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search links or usernames...';
    searchInput.style.cssText = 'width: 100%; padding: 6px; margin-bottom: 12px; box-sizing: border-box;';
    box.appendChild(searchInput);

    const list = document.createElement('ul');
    list.style.cssText = 'list-style: none; padding: 0; max-height: 80vh; overflow-y: auto;';
    box.appendChild(list);

    renderList(list, results);

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      const filtered = results.filter(r =>
        r.link.toLowerCase().includes(q) || r.username.toLowerCase().includes(q)
      );
      renderList(list, filtered);
    });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy all links';
    copyBtn.style.cssText = 'margin-top: 12px; margin-right: 8px; padding: 4px 10px; cursor: pointer;';
    copyBtn.addEventListener('click', () => {
      const text = results.map(r => r.link).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy all links'; }, 1500);
      });
    });
    box.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'margin-top: 12px; padding: 4px 10px; cursor: pointer;';
    closeBtn.addEventListener('click', () => overlay.remove());
    box.appendChild(closeBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  async function extractLinks() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const teamName = parts[0];
    const routeType = parts[1]; // "channels" or "messages"
    const routeName = parts[2];

    if (!teamName || !routeName) {
      alert('Could not detect team/channel from URL.');
      return;
    }

    let channelId;
    try {
      channelId = await getChannelId(teamName, routeType, routeName);
    } catch (err) {
      alert(err.message);
      return;
    }

    const perPage = 200;
    let page = 0;
    let keepGoing = true;
    const results = []; // { link, permalink, userId, createAt }

    while (keepGoing) {
      const res = await fetch(
        `${baseUrl}/api/v4/channels/${channelId}/posts?page=${page}&per_page=${perPage}`,
        { credentials: 'include' }
      );
      if (!res.ok) {
        alert(`Request failed with status ${res.status}`);
        break;
      }
      const data = await res.json();
      const posts = Object.values(data.posts || {});
      if (posts.length === 0) {
        keepGoing = false;
        break;
      }

      for (const post of posts) {
        const matches = post.message.match(/https?:\/\/[^\s)>\]]+/g);
        if (matches) {
          const permalink = `${baseUrl}/${teamName}/pl/${post.id}`;
          matches.forEach(link => results.push({
            link,
            permalink,
            userId: post.user_id,
            createAt: post.create_at
          }));
        }
      }

      if (posts.length < perPage) keepGoing = false;
      page++;
    }

    const usernameMap = await getUsernameMap(results.map(r => r.userId));
    results.forEach(r => {
      r.username = usernameMap[r.userId] || r.userId;
      r.date = new Date(r.createAt).toLocaleString();
    });

    showResults(results, routeName);
  }

  function injectButton() {
    const container = document.querySelector('#RightControlsContainer, .RightControlsContainer');
    if (!container || container.querySelector('.link-extractor-btn')) return;

    const btn = document.createElement('button');
    btn.textContent = 'Extract Links';
    btn.className = 'link-extractor-btn';
    btn.style.cssText = 'margin: 0 8px; padding: 4px 10px; cursor: pointer;';
    btn.addEventListener('click', extractLinks);

    container.prepend(btn);
  }

  const observer = new MutationObserver(injectButton);
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();