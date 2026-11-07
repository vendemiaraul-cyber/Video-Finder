# SearXNG for MeoDeo, as a Hugging Face Docker Space.
FROM docker.io/searxng/searxng:latest

# Hugging Face runs the container as user 1000: let it read the settings and
# write SearXNG's cache.
USER root
COPY settings.yml /etc/searxng/settings.yml
RUN chmod -R a+rwX /etc/searxng /var/cache/searxng

# Listen where Hugging Face expects (app_port in README.md), on IPv4.
ENV GRANIAN_HOST=0.0.0.0 \
    GRANIAN_PORT=7860 \
    FORCE_OWNERSHIP=false
EXPOSE 7860
