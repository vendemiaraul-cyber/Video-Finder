# SearXNG for MeoDeo (JSON API on, limiter off), behind a small key lock.
# Works on Render's free plan (Docker web service) or any Docker host.
FROM docker.io/searxng/searxng:latest

USER root
COPY settings.yml /etc/searxng/settings.yml
COPY --chmod=755 gate.py start.sh /usr/local/searxng/
RUN chmod -R a+rwX /etc/searxng /var/cache/searxng

# Render sets PORT (default 10000); MEODEO_KEY and SEARXNG_SECRET come from
# the service's environment variables.
ENV FORCE_OWNERSHIP=false
EXPOSE 10000
ENTRYPOINT ["/usr/local/searxng/start.sh"]
